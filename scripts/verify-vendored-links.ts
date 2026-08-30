/**
 * Verify that bun.lock resolves every vendored package name to its workspace
 * entry — never a registry copy. bun links a workspace package for any
 * dependency range spelled `workspace:`; a registry copy of the same name
 * coexisting with the vendored one silently forks the framework layer
 * (vendor/README.md).
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from 'jsonc-parser'

const root = resolve(import.meta.dirname, '..')

async function vendoredNames(): Promise<Set<string>> {
  const names = new Set<string>()
  for (const entry of await readdir(join(root, 'vendor'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let manifest: { name?: string }
    try {
      manifest = JSON.parse(await readFile(join(root, 'vendor', entry.name, 'package.json'), 'utf8')) as { name?: string }
    } catch {
      continue // not a package directory (e.g. vendor/README.md siblings)
    }
    if (manifest.name !== undefined) names.add(manifest.name)
  }
  return names
}

/** Dependency sections a workspace entry can name a vendored package from. */
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

interface Lockfile {
  workspaces?: Record<string, Partial<Record<(typeof SECTIONS)[number], Record<string, string>>>>
  /** Each resolution is a tuple whose first member is the `<name>@<resolution>` descriptor. */
  packages?: Record<string, [descriptor: string, ...rest: unknown[]]>
}

const names = await vendoredNames()
if (names.size === 0) throw new Error('verify-vendored-links: no vendored package manifests found under vendor/')

// bun writes its lockfile as JSONC (trailing commas), so it needs a tolerant parser.
const errors: { error: number; offset: number; length: number }[] = []
const lockfile = parse(await readFile(join(root, 'bun.lock'), 'utf8'), errors, { allowTrailingComma: true }) as Lockfile
if (errors.length > 0) {
  throw new Error(`verify-vendored-links: bun.lock is not parseable (${String(errors.length)} syntax error(s), first at offset ${String(errors[0]?.offset)}).`)
}
if (lockfile.workspaces === undefined || lockfile.packages === undefined) {
  throw new Error('verify-vendored-links: bun.lock has no workspaces/packages sections; the lockfile format changed.')
}

const violations: string[] = []

// Declared ranges: every dependency entry naming a vendored package must ask
// for the workspace, or the build silently resolves a registry copy.
for (const [importer, sections] of Object.entries(lockfile.workspaces)) {
  for (const section of SECTIONS) {
    for (const [dependency, range] of Object.entries(sections[section] ?? {})) {
      if (!names.has(dependency)) continue
      if (!range.startsWith('workspace:')) {
        violations.push(`${importer === '' ? '<root>' : importer} ${section}.${dependency} declares ${JSON.stringify(range)} (expected workspace:)`)
      }
    }
  }
}

// Resolutions: a vendored name must resolve to `<name>@workspace:<dir>`; any
// other descriptor is a registry copy materialized behind the same name.
for (const [name, entry] of Object.entries(lockfile.packages)) {
  if (!names.has(name)) continue
  const descriptor = entry[0]
  if (!descriptor.startsWith(`${name}@workspace:`)) {
    violations.push(`packages entry ${JSON.stringify(descriptor)} is a registry copy of a vendored package`)
  }
}

// A vendored name absent from `packages` is not linked at all, which the range
// scan cannot see when no importer happens to declare it.
for (const name of names) {
  if (!(name in lockfile.packages)) violations.push(`packages has no entry for vendored package ${name}`)
}

if (violations.length > 0) {
  console.error(`verify-vendored-links: ${String(violations.length)} lockfile resolution(s) bypass the vendored workspaces:`)
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}
console.log(`verify-vendored-links: all ${String(names.size)} vendored package names resolve to workspace links.`)
