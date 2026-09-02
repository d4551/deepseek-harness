/**
 * Expand the workspace path aliases that a wildcard would otherwise resolve by
 * probing every package group in turn.
 *
 * `tsconfig.base.json` is the resolution facade for the whole repository, and
 * two of its aliases used one key per *group* rather than per package:
 * `@deepseek-ai/dsh-*` listed 49 candidate globs and `@deepseek-ai/dsh-*\/invariant`
 * listed 45. TypeScript and tsx try those candidates in order, so a specifier
 * whose package sits late in the list pays for every earlier miss. Under tsx's
 * ESM hook each miss is an `ERR_MODULE_NOT_FOUND` that Node decorates with a
 * full CommonJS resolution walk, which dominated source-launch boot.
 *
 * This generator writes one explicit entry per package into a marked region of
 * `tsconfig.base.json`, leaving every hand-written alias and comment outside
 * that region untouched. `--check` reports drift instead of writing, so a new
 * package that needs an alias fails a gate rather than silently resolving
 * through a fallback that no longer exists.
 *
 * @module scripts/gen-tsconfig-paths
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONFIG = join(ROOT, 'tsconfig.base.json')
const BEGIN = '      // BEGIN generated package aliases — bun run gen-tsconfig-paths'
const END = '      // END generated package aliases'

/** Package-name prefix the expanded aliases cover. */
const PREFIX = '@deepseek-ai/dsh-'

/** One published subpath export mapped to its source entry file. */
export interface PackageSubpath {
  /** Export key without the `./` prefix, e.g. `policy`. */
  readonly name: string
  /** Repository-relative source entry, e.g. `./packages/web/web-fetch-http/src/policy.ts`. */
  readonly entry: string
}

/** Manifest fields the alias generator reads. */
interface ManifestShape {
  readonly name?: string
  readonly exports?: object
}

/** One workspace package the generated region maps. */
interface PackageAlias {
  /** Bare specifier, e.g. `@deepseek-ai/dsh-session`. */
  readonly specifier: string
  /** Repository-relative source directory, e.g. `./packages/session/session/src`. */
  readonly source: string
  /** Whether the package carries `src/invariant.ts`, which earns a second alias. */
  readonly hasInvariant: boolean
  /** Published non-root subpath exports with a matching `src/<name>.ts` or `src/<name>/index.ts`. */
  readonly subpaths: readonly PackageSubpath[]
}

/**
 * Read a workspace manifest.
 * @param path - absolute path to a `package.json`.
 * @returns The parsed manifest fields the generator reads.
 */
function readManifest(path: string): ManifestShape {
  return JSON.parse(readFileSync(path, 'utf8')) as ManifestShape
}

/**
 * Read a manifest's published non-root subpath exports that carry a source
 * counterpart, so the generated region maps them to source instead of letting
 * them resolve through the package `exports` map to built `lib/` output.
 * @param manifest - parsed package manifest.
 * @param packageDir - absolute package directory.
 * @param source - repository-relative source directory the bare alias uses.
 * @returns Subpaths sorted by name.
 */
export function collectSubpaths(
  manifest: ManifestShape,
  packageDir: string,
  source: string,
): PackageSubpath[] {
  const exportsMap = manifest.exports
  if (exportsMap === undefined) return []
  const subpaths: PackageSubpath[] = []
  for (const key of Object.keys(exportsMap)) {
    if (!key.startsWith('./') || key.includes('*')) continue
    const name = key.slice(2)
    if (name === '' || name === 'package.json' || name === 'invariant' || name.endsWith('/')) continue
    if (existsSync(join(packageDir, 'src', `${name}.ts`))) {
      subpaths.push({ name, entry: `${source}/${name}.ts` })
    } else if (existsSync(join(packageDir, 'src', name, 'index.ts'))) {
      subpaths.push({ name, entry: `${source}/${name}/index.ts` })
    }
  }
  return subpaths.sort((left, right) => left.name.localeCompare(right.name))
}

/** One workspace package directory, its declared name, and parsed manifest. */
interface WorkspacePackage {
  readonly group: string
  readonly directory: string
  readonly packageDir: string
  readonly name: string
  readonly manifest: ManifestShape
}

/**
 * Walk `packages/<group>/<directory>` once, in a stable order.
 * @returns Every directory whose manifest names a `@deepseek-ai/dsh-` package and that carries `src`.
 */
function workspacePackages(): WorkspacePackage[] {
  const packages = join(ROOT, 'packages')
  const found: WorkspacePackage[] = []
  for (const group of readdirSync(packages).sort()) {
    const groupDir = join(packages, group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const directory of readdirSync(groupDir).sort()) {
      const packageDir = join(groupDir, directory)
      if (!statSync(packageDir).isDirectory()) continue
      const manifest = readManifest(join(packageDir, 'package.json'))
      const name = manifest.name
      if (name === undefined || !name.startsWith(PREFIX)) continue
      if (existsSync(join(packageDir, 'src'))) found.push({ group, directory, packageDir, name, manifest })
    }
  }
  return found
}

/**
 * Collect every package the removed wildcards could resolve.
 *
 * A wildcard substituted the specifier's suffix into `packages/<group>/<suffix>/src`,
 * so it only ever resolved a package whose declared name is exactly
 * `@deepseek-ai/dsh-<directory>`. Packages named after something other than
 * their directory already carry a hand-written alias and are skipped here.
 *
 * @returns Aliases sorted by specifier.
 * @throws When two package directories claim one specifier, which the removed
 * wildcards resolved by group order and an explicit map cannot express.
 */
export function collectPackageAliases(): PackageAlias[] {
  const bySpecifier = new Map<string, PackageAlias & { directory: string }>()
  for (const { group, directory, packageDir, name, manifest } of workspacePackages()) {
    if (name !== `${PREFIX}${directory}`) continue
    const previous = bySpecifier.get(name)
    if (previous !== undefined) {
      throw new Error(
        `gen-tsconfig-paths: ${name} is claimed by packages/${previous.directory} and packages/${group}/${directory}; `
        + 'an explicit alias cannot express the group-order tiebreak the wildcard used.',
      )
    }
    const source = `./packages/${group}/${directory}/src`
    bySpecifier.set(name, {
      specifier: name,
      source,
      hasInvariant: existsSync(join(packageDir, 'src', 'invariant.ts')),
      subpaths: collectSubpaths(manifest, packageDir, source),
      directory: `${group}/${directory}`,
    })
  }
  return [...bySpecifier.values()]
    .map(({ specifier, source, hasInvariant, subpaths }) => ({ specifier, source, hasInvariant, subpaths }))
    .sort((left, right) => left.specifier.localeCompare(right.specifier))
}

/**
 * Collect every workspace package the aliases must cover.
 *
 * Unlike {@link collectPackageAliases} this keeps packages whose name does not
 * match their directory. The generator cannot map those — only a hand-written
 * alias can — but they still have to be mapped by something, because deleting
 * the group wildcards removed the fallback that used to catch them.
 *
 * @returns Declared names of every `@deepseek-ai/dsh-` package carrying a `src` directory.
 */
export function collectPackageNames(): string[] {
  return workspacePackages()
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right))
}

/**
 * Read the package specifiers a config maps, generated region included:
 * bare names and `name/subpath` keys alike.
 * @param text - `tsconfig.base.json` contents.
 * @returns Specifiers the config maps.
 */
export function mappedSpecifiers(text: string): Set<string> {
  const keys = new Set<string>()
  for (const match of text.matchAll(/^\s*"(@deepseek-ai\/dsh-[^"]+)":/gm)) {
    const key = match[1]
    if (key !== undefined) keys.add(key)
  }
  return keys
}

/**
 * Report packages that no alias maps.
 *
 * A package missing from `paths` still resolves — through the workspace symlink
 * and the package's own `exports` — but to built `lib/` output rather than to
 * source, which is the artifact-plane leak the explicit aliases exist to avoid.
 * Naming it here turns that into a gate failure instead of a silent difference.
 *
 * @param packages - every workspace package that needs an alias.
 * @param mapped - bare specifiers the config maps.
 * @returns Unmapped package names, in the order given.
 */
export function uncoveredPackages(
  packages: readonly string[],
  mapped: ReadonlySet<string>,
): string[] {
  return packages.filter(name => !mapped.has(name))
}

/**
 * Report published subpath exports no alias maps.
 *
 * A subpath export whose source counterpart exists must resolve to that source
 * like the bare specifier does; unmapped, it falls through the package
 * `exports` map to built `lib/` output.
 * @param aliases - generated aliases with their published subpaths.
 * @param mapped - bare and subpath specifiers the config maps.
 * @returns Unmapped subpath specifiers, in emission order.
 */
export function uncoveredSubpaths(
  aliases: readonly PackageAlias[],
  mapped: ReadonlySet<string>,
): string[] {
  const uncovered: string[] = []
  for (const alias of aliases) {
    for (const subpath of alias.subpaths) {
      const key = `${alias.specifier}/${subpath.name}`
      if (!mapped.has(key)) uncovered.push(key)
    }
  }
  return uncovered
}

/**
 * Render the generated region's alias lines.
 * @param aliases - packages to map, in emission order.
 * @param handWritten - specifiers already mapped outside the region; a duplicate key would shadow one silently.
 * @returns The region body, one JSON member per line.
 */
export function renderAliases(aliases: readonly PackageAlias[], handWritten: ReadonlySet<string>): string {
  const lines: string[] = []
  for (const alias of aliases) {
    if (!handWritten.has(alias.specifier)) {
      lines.push(`      ${JSON.stringify(alias.specifier)}: [${JSON.stringify(alias.source)}]`)
    }
    const invariant = `${alias.specifier}/invariant`
    if (alias.hasInvariant && !handWritten.has(invariant)) {
      lines.push(`      ${JSON.stringify(invariant)}: [${JSON.stringify(`${alias.source}/invariant.ts`)}]`)
    }
    for (const subpath of alias.subpaths) {
      const key = `${alias.specifier}/${subpath.name}`
      if (!handWritten.has(key)) {
        lines.push(`      ${JSON.stringify(key)}: [${JSON.stringify(subpath.entry)}]`)
      }
    }
  }
  // The region closes `paths`, so the last member carries no trailing comma.
  return lines.join(',\n')
}

/**
 * Replace the generated region of a config's text.
 * @param text - current `tsconfig.base.json` contents.
 * @param body - rendered alias lines.
 * @returns The updated contents.
 * @throws When the markers are missing or out of order.
 */
export function writeRegion(text: string, body: string): string {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin < 0 || end < begin) {
    throw new Error(`gen-tsconfig-paths: ${CONFIG} is missing the generated-region markers.`)
  }
  return `${text.slice(0, begin)}${BEGIN}\n${body}\n${END}${text.slice(end + END.length)}`
}

/**
 * Parse the config's `paths` keys, ignoring the generated region.
 * @param text - current `tsconfig.base.json` contents.
 * @returns Specifiers mapped by hand.
 */
function handWrittenSpecifiers(text: string): Set<string> {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  const outside = begin < 0 || end < begin ? text : text.slice(0, begin) + text.slice(end)
  const keys = new Set<string>()
  for (const match of outside.matchAll(/^\s*"(@deepseek-ai\/[^"]+)":/gm)) {
    const key = match[1]
    if (key !== undefined) keys.add(key)
  }
  return keys
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const check = process.argv.includes('--check')
  const current = readFileSync(CONFIG, 'utf8')
  const aliases = collectPackageAliases()
  const next = writeRegion(current, renderAliases(aliases, handWrittenSpecifiers(current)))
  const uncovered = uncoveredPackages(collectPackageNames(), mappedSpecifiers(next))
  const uncoveredSub = uncoveredSubpaths(aliases, mappedSpecifiers(next))
  if (uncovered.length > 0) {
    process.stderr.write(
      'gen-tsconfig-paths: no alias maps '
      + `${uncovered.join(', ')}; add a hand-written entry, because a package named after `
      + 'something other than its directory cannot be generated.\n',
    )
  }
  if (uncoveredSub.length > 0) {
    process.stderr.write(
      'gen-tsconfig-paths: no alias maps these published subpath exports: '
      + `${uncoveredSub.join(', ')}; give each a source counterpart or a hand-written alias.\n`,
    )
  }
  if (uncovered.length === 0 && uncoveredSub.length === 0) {
    if (current === next) {
      process.stdout.write('gen-tsconfig-paths: tsconfig.base.json package aliases are current.\n')
    } else if (check) {
      process.stderr.write('gen-tsconfig-paths: tsconfig.base.json is stale; run `bun run gen-tsconfig-paths`.\n')
      process.exitCode = 1
    } else {
      writeFileSync(CONFIG, next)
      process.stdout.write('gen-tsconfig-paths: rewrote tsconfig.base.json package aliases.\n')
    }
  } else {
    process.exitCode = 1
  }
}
