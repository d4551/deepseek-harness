/**
 * Every shipped profile template names bundles this application can actually
 * boot. A template row is a promise that `dsh --profile <name>` works, and
 * `loadProfile` needs three separate things from each named bundle before it
 * can build a layer: the CLI must declare the package, the package's manifest
 * must carry `dsh.bundle.patch`, and that patch file must exist and parse.
 * Each has its own `throw` in `profile.ts`, so each is asserted here.
 *
 * Dependency declaration is checked against the manifest rather than by
 * resolving the specifier: the source-plane runner resolves `@deepseek-ai/*`
 * through tsconfig `paths` no matter what the installed tree holds, so a
 * resolution check would pass for a bundle a packed install could never find.
 * The patch itself is read from the workspace directory the name maps to,
 * and the last case checks that `files` actually packs it, because a bundle
 * that resolves and parses in this tree still ships an unbootable profile
 * when the tarball omits the patch.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

interface BundleManifest {
  name?: string
  files?: string[]
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as BundleManifest

const declared = new Set(Object.keys(manifest.dependencies ?? {}))

/**
 * Map every workspace package name to the directory that owns its manifest.
 * @returns npm name to absolute package directory for all `packages/<group>/<pkg>`.
 */
function workspacePackages(): Map<string, string> {
  const packages = new Map<string, string>()
  const root = join(repoRoot, 'packages')
  for (const group of readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const groupDir = join(root, group.name)
    for (const pkg of readdirSync(groupDir, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const dir = join(groupDir, pkg.name)
      const file = join(dir, 'package.json')
      if (!existsSync(file)) continue
      const name = (JSON.parse(readFileSync(file, 'utf8')) as BundleManifest).name
      if (name !== undefined) packages.set(name, dir)
    }
  }
  return packages
}

const workspace = workspacePackages()

/** Every distinct bundle name any shipped template stacks, with its template. */
const namedBundles = Object.entries(PROFILE_TEMPLATES).flatMap(([profile, template]) =>
  template.bundles.map(bundle => ({ profile, bundle })))

describe('shipped profile templates', () => {
  it('names at least one bundle per template, over a real template set', () => {
    const names = Object.keys(PROFILE_TEMPLATES)
    expect(names.length).toBeGreaterThan(3)
    for (const name of names) expect(PROFILE_TEMPLATES[name]?.bundles.length, name).toBeGreaterThan(0)
  })

  it('declares every bundle every template names, so each profile can resolve them', () => {
    // A missing entry is how a profile ships unbootable: the template row reads
    // as support for it, and the failure only appears when someone runs it.
    const missing = namedBundles
      .filter(({ bundle }) => !declared.has(bundle))
      .map(({ profile, bundle }) => `${profile} -> ${bundle}`)
    expect(missing).toEqual([])
  })

  it('names every shipped template in the pages a user reads to find one', () => {
    // A profile that boots and appears in no document ships to nobody. Both
    // pages cite profiles as backticked names, which also keeps `sdk` from
    // matching inside `sdk-minimal`.
    const pages = ['apps/cli/README.md', 'apps/cli/README.zh.md', 'docs/architecture.md', 'docs/architecture.zh.md']
    const undocumented = pages.flatMap((page) => {
      const text = readFileSync(join(repoRoot, page), 'utf8')
      return Object.keys(PROFILE_TEMPLATES)
        .filter(name => !text.includes(`\`${name}\``))
        .map(name => `${page} -> ${name}`)
    })
    expect(undocumented).toEqual([])
  })

  it('carries a dsh.bundle.patch field in every named bundle manifest', () => {
    // `loadProfile` throws "declares no dsh.bundle" on an absent field, so a
    // bundle that resolves and states nothing still refuses to boot.
    const undeclared = namedBundles
      .filter(({ bundle }) => {
        const dir = workspace.get(bundle)
        return dir === undefined
          || (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as BundleManifest).dsh?.bundle?.patch === undefined
      })
      .map(({ profile, bundle }) => `${profile} -> ${bundle}`)
    expect(undeclared).toEqual([])
  })

  it('packs the patch in every named bundle, so an installed profile still boots', () => {
    // `files` decides the tarball. A patch present here and absent from the
    // package is the orphan shape rounds 23 and 27 caught, one layer further
    // out: nothing in this repository would notice until someone installed it.
    const unpacked = namedBundles.flatMap(({ profile, bundle }) => {
      const dir = workspace.get(bundle)
      if (dir === undefined) return []
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as BundleManifest
      const declaredPatch = pkg.dsh?.bundle?.patch
      if (declaredPatch === undefined) return []
      const packed = pkg.files ?? []
      const target = declaredPatch.replace(/^\.\//u, '')
      // An entry packs the patch by naming it, or by naming a directory above it.
      const covered = packed.some((entry) => {
        const cleaned = entry.replace(/^\.\//u, '').replace(/\/$/u, '')
        return cleaned === target || target.startsWith(`${cleaned}/`)
      })
      return covered ? [] : [`${profile} -> ${bundle}: files does not pack ${declaredPatch}`]
    })
    expect(unpacked).toEqual([])
  })

  it('points every dsh.bundle.patch at a patch file that exists and parses', () => {
    // The field naming a file that is absent, or holding YAML the loader's own
    // entry schema rejects, fails at `loadOverlayPatches` rather than at boot.
    const broken = namedBundles.flatMap(({ profile, bundle }) => {
      const dir = workspace.get(bundle)
      if (dir === undefined) return [`${profile} -> ${bundle}: no workspace package`]
      const declaredPatch = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as BundleManifest).dsh?.bundle?.patch
      if (declaredPatch === undefined) return []
      const patchPath = join(dir, declaredPatch)
      if (!existsSync(patchPath)) return [`${profile} -> ${bundle}: ${declaredPatch} does not exist`]
      const rows = yaml.load(readFileSync(patchPath, 'utf8'), { schema: entryListSchema })
      return Array.isArray(rows) && rows.length > 0 ? [] : [`${profile} -> ${bundle}: ${declaredPatch} states no rows`]
    })
    expect(broken).toEqual([])
  })
})
