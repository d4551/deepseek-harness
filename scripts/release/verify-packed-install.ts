/**
 * Install packed tarballs into a throwaway consumer outside the repository and
 * drive the installed executable with plain Node.
 *
 * Every tarball the installed tree needs comes from `--from`, so the only
 * registry traffic is for external dependencies. That matters beyond hermetic
 * verification: the harness packages declare the vendored framework as a peer,
 * those packages live in another release sequence, and this job must not depend
 * on the registry already carrying versions that match — one pull request may
 * bump both families before either publishes — so a dsh verification passes the
 * vendored family's pack output too, while publishing only its own
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 *
 * What this proves is that `files` selected a complete payload and that the
 * published dependency ranges resolve. A workspace link or a stale `lib/` in the
 * checkout cannot stand in for a missing file here.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { releaseFamily } from './families.ts'
import { integrationReleaseFiles, parseIntegrationReleaseControl } from './integration-release-contract.ts'
import { capture, isEntry } from './process.ts'
import { packedIdentity } from './tarball.ts'

/**
 * Environment for the installed artifact: no host Node hooks, no host DeepSeek
 * Harness home, and no ambient npm user agent that would confuse npm.
 * @param consumerRoot - the throwaway consumer directory.
 * @returns The child environment.
 */
function consumerEnvironment(consumerRoot: string): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  delete environment.npm_config_user_agent
  delete environment.NPM_CONFIG_USER_AGENT
  delete environment.NODE_OPTIONS
  delete environment.NODE_PATH
  environment.DSH_HOME = resolve(consumerRoot, '.dsh')
  environment.DSH_AGENTS_HOME = resolve(consumerRoot, '.agents')
  environment.DSH_TELEMETRY_DISABLED = '1'
  return environment
}

/**
 * Every packed tarball in the given directories, as `file:` dependency entries.
 *
 * The directories are read by their contents rather than a pack order file: a
 * directory here can hold tarballs packed only to satisfy a cross-sequence
 * dependency, which no release order describes.
 * @param directories - absolute directories holding packed tarballs.
 * @returns Package name to tarball file URL, and the version each carries.
 */
function packedDependencies(directories: readonly string[]): Map<string, { url: string; version: string }> {
  const dependencies = new Map<string, { url: string; version: string }>()
  for (const directory of directories) {
    const tarballs = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`${directory} holds no packed tarball`)
    for (const filename of tarballs) {
      const tarball = join(directory, filename)
      const { name, version } = packedIdentity(tarball)
      dependencies.set(name, { url: pathToFileURL(tarball).href, version })
    }
  }
  return dependencies
}

function verifyRuntimeRequirements(
  engine: { readonly minimumExactMajor: number; readonly minimumExactMinor: number; readonly minimumMajor: number },
  packageManager: string,
): void {
  const [majorText, minorText] = process.versions.node.split('.')
  const major = Number(majorText)
  const minor = Number(minorText)
  const allowed =
    (major === engine.minimumExactMajor && minor >= engine.minimumExactMinor) || major >= engine.minimumMajor
  if (!allowed) throw new Error(`Node ${process.versions.node} is outside the integration release engine`)
  const separator = packageManager.lastIndexOf('@')
  const expectedBun = packageManager.slice(separator + 1)
  const actualBun = capture('bun', ['--version'])
  if (actualBun !== expectedBun) {
    throw new Error(`Bun ${actualBun} differs from integration release ${expectedBun}`)
  }
}

function verifyInstalledPackages(
  consumerRoot: string,
  packages: readonly { readonly name: string; readonly version: string }[],
): void {
  const root = realpathSync(consumerRoot)
  for (const entry of packages) {
    const directory = join(consumerRoot, 'node_modules', ...entry.name.split('/'))
    if (!existsSync(directory)) throw new Error(`installed runtime lacks ${entry.name}`)
    const installed = realpathSync(directory)
    if (!installed.startsWith(`${root}/`)) throw new Error(`installed runtime links ${entry.name} outside its root`)
    const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (
      manifest === null ||
      typeof manifest !== 'object' ||
      !('name' in manifest) ||
      manifest.name !== entry.name ||
      !('version' in manifest) ||
      manifest.version !== entry.version
    ) {
      throw new Error(`installed runtime package identity differs for ${entry.name}`)
    }
  }
}

function verifyInstalledNative(consumerRoot: string, environment: NodeJS.ProcessEnv): void {
  const driver = join(consumerRoot, 'verify-native.mjs')
  writeFileSync(driver, `
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { grantArgs, launcherPath, probe } from '@deepseek-ai/node-addon-landlock-run'

const launcher = launcherPath()
assert.ok(path.isAbsolute(launcher))
if (process.platform === 'linux') {
  assert.ok(fs.existsSync(launcher), 'installed Landlock launcher is absent')
  fs.accessSync(launcher, fs.constants.X_OK)
  const enforcement = probe(launcher)
  if (enforcement === 'unusable' && process.env.NALR_REQUIRE_LANDLOCK === '1') {
    throw new Error('installed Landlock launcher is unusable')
  }
  if (enforcement !== 'unusable') {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-integration-landlock-'))
    const denied = path.join(work, 'denied.txt')
    const granted = path.join(work, 'granted.txt')
    const writer = "require('node:fs').writeFileSync(process.argv[1], 'verified')"
    const deniedRun = spawnSync(launcher, [...grantArgs({ readOnly: ['/'] }), '--', process.execPath, '-e', writer, denied], { encoding: 'utf8' })
    assert.notEqual(deniedRun.status, 0, 'write outside Landlock grants succeeded')
    assert.equal(fs.existsSync(denied), false, 'denied write reached disk')
    const grantedRun = spawnSync(launcher, [...grantArgs({ readOnly: ['/'], readWrite: [work] }), '--', process.execPath, '-e', writer, granted], { encoding: 'utf8' })
    assert.equal(grantedRun.status, 0, grantedRun.stderr)
    assert.equal(fs.readFileSync(granted, 'utf8'), 'verified')
  }
} else {
  assert.equal(fs.existsSync(launcher), false)
  assert.equal(probe(launcher), 'unusable')
}
`)
  capture(process.execPath, [driver], { cwd: consumerRoot, env: environment })
}

function verifyIntegration(controlFile: string, packFile: string): void {
  const control = parseIntegrationReleaseControl(readFileSync(controlFile))
  if (control.runtime.platform !== `${process.platform}-${process.arch}`) {
    throw new Error(`integration release targets ${control.runtime.platform}, not ${process.platform}-${process.arch}`)
  }
  verifyRuntimeRequirements(control.runtime.node, control.runtime.packageManager)
  const files = integrationReleaseFiles(control, readFileSync(packFile))
  const consumerRoot = mkdtempSync(join(tmpdir(), 'dsh-integration-install-'))
  try {
    for (const [path, bytes] of files) {
      const destination = join(consumerRoot, path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, bytes, { flag: 'wx', mode: 0o444 })
    }
    const environment = consumerEnvironment(consumerRoot)
    capture('bun', [
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--backend=copyfile',
      '--no-progress',
    ], { cwd: consumerRoot, env: environment })
    verifyInstalledPackages(consumerRoot, control.packages)
    const bin = join(
      consumerRoot,
      'node_modules',
      ...control.runtime.entry.package.split('/'),
      control.runtime.entry.path,
    )
    const version = capture(process.execPath, [bin, '--version'], { cwd: consumerRoot, env: environment })
    if (version !== control.runtime.entry.version) {
      throw new Error(`installed dsh reports ${JSON.stringify(version)}, expected ${control.runtime.entry.version}`)
    }
    verifyInstalledNative(consumerRoot, environment)
    console.log(`release verify-packed-install: integrated dsh reports ${version}`)
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
}

/** Install every tarball under `--from` and drive the `--family` entry. */
function main(): void {
  const { values } = parseArgs({
    options: {
      control: { type: 'string' },
      family: { type: 'string' },
      from: { type: 'string', multiple: true },
      pack: { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.control !== undefined || values.pack !== undefined) {
    if (values.control === undefined || values.pack === undefined || values.family !== undefined || values.from !== undefined) {
      throw new Error('usage: verify-packed-install.ts --control <control file> --pack <pack file>')
    }
    const root = process.cwd()
    verifyIntegration(resolve(root, values.control), resolve(root, values.pack))
    return
  }
  if (values.family === undefined || values.from === undefined || values.from.length === 0) {
    throw new Error('usage: verify-packed-install.ts --family <dsh|vendor> --from <packed directory> [--from ...]')
  }

  const family = releaseFamily(values.family)
  const entry = family.installedEntry
  if (entry === undefined) {
    console.log(`release verify-packed-install: family ${family.id} publishes no executable, nothing to drive`)
    return
  }

  const root = process.cwd()
  const packed = packedDependencies(values.from.map(directory => resolve(root, directory)))
  const expected = packed.get(entry.packageName)
  if (expected === undefined) throw new Error(`${entry.packageName} is not among the packed tarballs`)

  const consumerRoot = mkdtempSync(join(tmpdir(), `dsh-packed-${family.id}-`))
  try {
    writeFileSync(join(consumerRoot, 'package.json'), `${JSON.stringify({
      name: `dsh-packed-install-${family.id}`,
      version: '0.0.0',
      private: true,
      dependencies: Object.fromEntries([...packed].map(([name, entryPacked]) => [name, entryPacked.url])),
    }, null, 2)}\n`)

    const environment = consumerEnvironment(consumerRoot)
    console.log(`release verify-packed-install: installing ${String(packed.size)} tarball(s) into ${consumerRoot}`)
    // Optional dependencies are omitted: the Landlock platform packages behind
    // them need a musl toolchain and one build per architecture, and a consumer
    // that cannot install them must still start — which is what optional means
    // here. Their entry package is a plain dependency of dsh-sandbox-local, so
    // its tarball is supplied through --from.
    capture('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', '--omit=optional'],
      { cwd: consumerRoot, env: environment })

    const bin = join(consumerRoot, 'node_modules', ...entry.packageName.split('/'), entry.binPath)
    const version = capture(process.execPath, [bin, '--version'], { cwd: consumerRoot, env: environment })
    if (version !== expected.version) {
      throw new Error(`installed ${entry.packageName} --version reported ${JSON.stringify(version)}, expected ${expected.version}`)
    }
    console.log(`release verify-packed-install: installed ${entry.packageName} reports ${version}`)
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
}

if (isEntry(import.meta.url)) main()
