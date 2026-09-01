/**
 * `dsh init --profile <name>` — write a profile's config files without
 * booting it: the manifest (`package.json` with its `dsh.profile` bundle
 * layer list and reload lifecycle), the empty user patch layer
 * (`cordis.patch.yml`), and the bun install settings out-of-tree plugins
 * resolve their peers through.
 *
 * The generator is explicit because a boot is not: `dsh --profile <name>`
 * creates only the shipped templates, so a misspelled shipped name stays a
 * loud failure instead of becoming an empty tree that boots and does nothing.
 * Running it twice is not an error — every file is written only when absent,
 * so an existing profile keeps its edits.
 * @module @deepseek-ai/dsh/init
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_PROFILE_BUNDLES,
  DEFAULT_PROFILE_PATCH_RELOAD,
  initProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  type ProfilePatchReload,
} from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/** The bundle layer list and reload lifecycle a new profile is created with. */
interface InitTemplate {
  bundles: readonly string[]
  patchReload: ProfilePatchReload
}

/**
 * Resolve what to write into a new profile's manifest. Explicit `--bundle`
 * layers win; otherwise a shipped name reproduces exactly what its first boot
 * would have created, and any other name starts from the default base layer.
 * @param name - the profile name.
 * @param bundles - `--bundle` layers in argv order; empty selects a default.
 * @returns the bundle layer list and patch-reload lifecycle to write.
 */
export function resolveInitTemplate(name: string, bundles: readonly string[]): InitTemplate {
  const shipped = PROFILE_TEMPLATES[name]
  if (bundles.length > 0) {
    return { bundles, patchReload: shipped?.patchReload ?? DEFAULT_PROFILE_PATCH_RELOAD }
  }
  if (shipped !== undefined) return { bundles: shipped.bundles, patchReload: shipped.patchReload }
  return { bundles: DEFAULT_PROFILE_BUNDLES, patchReload: DEFAULT_PROFILE_PATCH_RELOAD }
}

/**
 * Reject a `--bundle` layer that cannot become one: an unresolvable package,
 * or one that declares no `dsh.bundle` patch. Writing either would produce a
 * manifest whose next boot fails, which is the one outcome a generator must
 * not have. Template and default layers are installation-owned and are not
 * re-checked here; a boot that cannot resolve those describes a broken
 * installation, not a bad argument.
 * @param bundles - the `--bundle` layers, in argv order.
 * @param profileDir - the profile directory, the second resolution anchor.
 * @throws when a named layer does not resolve or exports no patch.
 */
export function assertBundlesUsable(bundles: readonly string[], profileDir: string): void {
  for (const packageName of bundles) {
    const dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)
    if (readProfileManifest(NAME, dir).dsh?.bundle?.patch === undefined) {
      throw new Error(`${NAME}: --bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json, so it cannot be a profile layer`)
    }
  }
}

/**
 * Create the named profile's config files, or report the ones already there.
 * @param name - the profile to create under `$DSH_HOME/profiles`.
 * @param bundles - `--bundle` layers in argv order; empty selects the shipped template or the default.
 * @param out - sink for the report lines.
 * @returns the process exit code.
 */
export function runInit(
  name: string, bundles: readonly string[],
  out: (line: string) => void = line => process.stdout.write(line),
): number {
  const dir = resolveProfileDir(name)
  const existed = existsSync(join(dir, 'package.json'))
  assertBundlesUsable(bundles, dir)
  const template = resolveInitTemplate(name, bundles)
  initProfile(dir, template.bundles, template.patchReload)
  const manifest = readProfileManifest(NAME, dir)
  const layers = manifest.dsh?.profile?.bundles ?? []
  out(`${NAME}: profile ${JSON.stringify(name)} ${existed ? 'already exists' : 'created'} at ${dir}\n`)
  out(`  bundle layers: ${layers.length > 0 ? layers.join(', ') : '(none)'}\n`)
  // An existing manifest is never rewritten, so --bundle on a second run
  // would otherwise look applied while the layer list stayed as it was.
  if (existed && bundles.length > 0) out('  --bundle was ignored: the existing manifest keeps its own layers\n')
  out(`  edit ${join(dir, PROFILE_PATCH_FILENAME)} to override rows\n`)
  out(`  add plugins with: ${NAME} plugin --profile ${name} add <package>\n`)
  out(`  boot it with: ${NAME} --profile ${name}\n`)
  return 0
}
