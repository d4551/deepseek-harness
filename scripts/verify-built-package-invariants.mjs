/** Verify every compiled companion through its staged package self-reference under plain Node. */

import {
  copyFileSync,
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const repositoryRoot = resolve(import.meta.dirname, '..')
const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: { 'packages-root': { type: 'string' }, 'loader-url': { type: 'string' } },
})
const packagesRoot = resolve(options['packages-root'] ?? repositoryRoot)
const loaderUrl = options['loader-url']
  ?? pathToFileURL(resolve(repositoryRoot, 'vendor/loader/lib/index.js')).href
const failures = []
const manifests = globSync('packages/*/*/package.json', { cwd: packagesRoot }).sort()
const { default: Loader } = await import(loaderUrl)
const loader = Object.create(Loader.prototype)

// The staged package view lives inside the tree under audit, so every way the
// process can end removes the current one: the probe's own `finally`, the
// `exit` event for an early end such as a companion whose top-level await never
// settles, and a SIGTERM/SIGINT listener that cleans up and re-raises the
// signal. `once` has dropped that listener before it runs, so the re-raised
// signal reaches the default disposition and ends the process with its status.
let stagedPackageDir
function removeStagedPackageDir() {
  if (stagedPackageDir === undefined) return
  rmSync(stagedPackageDir, { recursive: true, force: true })
  stagedPackageDir = undefined
}
process.on('exit', removeStagedPackageDir)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    removeStagedPackageDir()
    process.kill(process.pid, signal)
  })
}

/**
 * Verify one manifest's compiled companion inside a staged package view.
 * @param manifestPath - absolute path of the package manifest.
 * @returns `undefined` when the companion passes, else the failure's subject and reason.
 */
async function stageAndProbe(manifestPath) {
  const packageDir = dirname(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const packageName = manifest.name
  if (typeof packageName !== 'string' || packageName.length === 0) {
    return { subject: manifestPath, reason: 'missing package name' }
  }
  const invariantExport = manifest.exports?.['./invariant']
  if (typeof invariantExport !== 'object'
    || invariantExport.default !== './lib/invariant.js'
    || !manifest.files?.includes('lib/invariant.js')) {
    return { subject: packageName, reason: 'manifest does not publish ./lib/invariant.js as ./invariant' }
  }

  // Keep the staged view below its owning package so Node reaches the real
  // dependency links. Junctioning node_modules elsewhere breaks the isolated
  // linker's relative workspace links on Windows. Copy the manifest-declared lib view
  // so a companion that imports an undeclared runtime chunk fails here.
  stagedPackageDir = mkdtempSync(resolve(packageDir, '.dsh-built-invariant-'))
  try {
    copyFileSync(manifestPath, resolve(stagedPackageDir, 'package.json'))
    copyDeclaredLibFiles(packageDir, stagedPackageDir, manifest.files)
    const probePath = resolve(stagedPackageDir, 'probe.mjs')
    writeFileSync(
      probePath,
      `import * as companion from ${JSON.stringify(`${packageName}/invariant`)}\nexport default companion\n`,
    )
    const { default: companion } = await import(pathToFileURL(probePath).href)
    if ('default' in companion) throw new Error('companion has a default export')
    const unwrapped = loader.unwrapExports(companion)
    if (unwrapped !== companion) throw new Error('Loader collapsed the companion namespace')
    if (typeof unwrapped.name !== 'string') throw new Error('companion name is missing')
    if (!Array.isArray(unwrapped.inject) || !unwrapped.inject.includes('invariants')) {
      throw new Error('companion does not inject invariants')
    }
    if (typeof unwrapped.apply !== 'function') throw new Error('companion apply is missing')
    return undefined
  } catch (error) {
    return { subject: packageName, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    removeStagedPackageDir()
  }
}

for (const manifestPath of manifests) {
  const outcome = await stageAndProbe(resolve(packagesRoot, manifestPath))
  if (outcome !== undefined) failures.push(`${outcome.subject}: ${outcome.reason}`)
}

if (failures.length > 0) {
  console.error('verify-built-package-invariants: compiled companion failures:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-built-package-invariants: ${manifests.length} compiled companion(s) passed plain-Node Loader checks.`)

function copyDeclaredLibFiles(packageDir, stagedPackageDir, files) {
  for (const pattern of files) {
    if (!pattern.startsWith('lib/')) continue
    for (const relativePath of globSync(pattern, { cwd: packageDir })) {
      const source = resolve(packageDir, relativePath)
      if (!existsSync(source)) continue
      const target = resolve(stagedPackageDir, relativePath)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(source, target, { recursive: true })
    }
  }
}
