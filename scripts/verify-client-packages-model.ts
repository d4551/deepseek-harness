/**
 * Shared types, constants, and small helpers for the client-package gate.
 */

export const GATE = 'verify-client-packages'
export const CLIENT_MANIFEST_GLOB = 'packages/client/*/package.json'
export const MANIFEST_GLOBS = ['packages/*/*/package.json', 'apps/*/package.json', 'vendor/*/package.json']
export const CONFIG_GLOB = 'packages/*/*/tsdown.config.ts'
export const PLATFORM_SOURCE = 'packages/client/web/src/platform.ts'
export const PARSER_PRELOAD_SOURCE = 'packages/client/modules/src/index.ts'
export const STATIC_PRESET_SOURCE = 'packages/client/tsdown.client.ts'
export const CORDIS = '@deepseek-ai/cordis'
const DSH_PREFIX = '@deepseek-ai/dsh-'
const CLIENT_WEB = '@deepseek-ai/dsh-client-web'

/** One workspace package's browser-module declaration. */
export interface ClientDeclaration {
  readonly name: string
  readonly manifest: string
  readonly dynamic: boolean
  readonly external: readonly string[]
  readonly runtimeSourceUses: Readonly<Record<string, readonly string[]>>
  /** Exact runtime specifiers used to validate `dsh.client.external` declarations. */
  readonly runtimeSourceSpecifiers: Readonly<Record<string, readonly string[]>>
  /** Informational package dependencies declared by the row. */
  readonly inject: readonly string[]
}

/** One package directly under packages/client. */
export interface ClientPackage extends ClientDeclaration {
  readonly staticLinked: boolean
  readonly sourceUses: Readonly<Record<string, readonly string[]>>
  readonly dependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly devDependencies: Readonly<Record<string, string>>
}

/** Complete source-plane input to the client package verifier. */
export interface ClientPackageFacts {
  readonly packages: readonly ClientPackage[]
  readonly declarations: readonly ClientDeclaration[]
  readonly staticLinkedPackages: ReadonlySet<string>
  readonly platformModules: readonly string[]
  readonly preloadedExternals: readonly string[]
  readonly parserPreloadIds: readonly string[]
  readonly malformed: readonly string[]
}

/** Result of reading every workspace browser-module declaration. */
export interface ClientDeclarations {
  readonly declarations: ClientDeclaration[]
  readonly malformed: string[]
}

/** `dsh.client` fields the gate reads. */
interface ClientManifestClient {
  external?: readonly string[]
  inject?: readonly string[]
}

/** Optional `dsh` object on a package manifest. */
interface ClientManifestDsh {
  client?: ClientManifestClient
}

/** Parsed package.json fields the gate reads. */
export interface Manifest {
  name?: string
  dsh?: ClientManifestDsh
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** Expected npm section for one production use. */
export interface ExpectedRule {
  readonly kind: 'dependency' | 'dev' | 'peer-dev'
  readonly origins: Set<string>
}

/** The package name a module specifier resolves to. */
export function packageNameOf(specifier: string): string {
  const segments = specifier.split('/')
  return segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
}

/** Strip a trailing `/client` subpath used by some workspace specifiers. */
export function stripClientSuffix(specifier: string): string {
  return specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier
}

/** Names of dynamic `dsh.client` rows. */
export function rowNames(declarations: readonly ClientDeclaration[]): Set<string> {
  return new Set(declarations.filter(entry => entry.dynamic).map(entry => entry.name))
}

/** The dynamic row that answers one specifier, if any. */
export function rowPackageOf(specifier: string, rows: ReadonlySet<string>): string | undefined {
  if (rows.has(specifier)) return specifier
  const stripped = stripClientSuffix(specifier)
  return rows.has(stripped) ? stripped : undefined
}

/** Which npm sections currently declare `name`. */
export function declaredSections(pkg: ClientPackage, name: string): string[] {
  return (['dependencies', 'peerDependencies', 'devDependencies'] as const)
    .filter(section => pkg[section][name] !== undefined)
}

/** Human-readable section list for a violation. */
export function describeSections(sections: readonly string[]): string {
  return sections.length === 0 ? 'no dependency declaration' : sections.join(' + ')
}

/** Extra text when peer and dev ranges disagree. */
export function describeRangeMismatch(peer: string | undefined, dev: string | undefined): string {
  if (peer === undefined || dev === undefined || peer === dev) return ''
  return ' (peer ' + peer + ', dev ' + dev + ')'
}

/** Compact origin list for a violation. */
export function describeOrigins(origins: ReadonlySet<string>): string {
  const sorted = [...origins].sort()
  const [first, second, ...rest] = sorted
  if (first === undefined) return 'production use'
  if (second === undefined) return first
  return rest.length === 0 ? first + ', ' + second : first + ', ' + second + ', and ' + String(rest.length) + ' more'
}

/** Whether a specifier is a workspace DSH or Cordis package. */
export function isInternalDsh(name: string): boolean {
  return name === CORDIS || name.startsWith(DSH_PREFIX)
}

/** Slash-normalize a path glob result. */
export function normalizePath(path: string): string {
  return path.split(/\\|\//).join('/')
}

/**
 * Expected npm sections for one client package's production uses.
 * @param pkg - the package under review.
 * @param staticInputs - packages the static client graph already provides.
 * @returns name → expected section rule.
 */
export function expectedSections(pkg: ClientPackage, staticInputs: ReadonlySet<string>): Map<string, ExpectedRule> {
  const expected = new Map<string, ExpectedRule>([
    [CORDIS, { kind: 'peer-dev', origins: new Set(['client package baseline']) }],
  ])
  if (!pkg.dynamic) {
    if (pkg.name === CLIENT_WEB) return expected
    for (const [name, locations] of Object.entries(pkg.runtimeSourceUses)) {
      if (name === pkg.name || name === CORDIS || isInternalDsh(name)) continue
      expected.set(name, { kind: 'dependency', origins: new Set(locations) })
    }
    return expected
  }

  const add = (name: string, origin: string): void => {
    if (name === pkg.name) return
    const kind = staticInputs.has(name) ? 'dev' : isInternalDsh(name) ? 'peer-dev' : undefined
    if (kind === undefined) return
    const current = expected.get(name)
    if (current !== undefined) current.origins.add(origin)
    else expected.set(name, { kind, origins: new Set([origin]) })
  }
  for (const [name, locations] of Object.entries(pkg.sourceUses)) {
    for (const location of locations) add(name, location)
  }
  for (const name of pkg.inject) add(name, 'dsh.client.inject')
  return expected
}
