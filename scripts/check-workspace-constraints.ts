/**
 * Workspace package invariant checks for package-manager-independent quality
 * gates.
 *
 * Run: `tsx scripts/check-workspace-constraints.ts`.
 */

import { existsSync, globSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hasTypertRemoteNavigation, isForbiddenPublicationFile } from './publication-payload.ts'
import { collectProjectReferenceFaceViolations } from './project-reference-faces.ts'
import { readConfigFile } from './ts7-session.ts'

const root = resolve(import.meta.dirname, '..')
// vendor/* is single-level; packages/<group>/<pkg> nests one level deeper
// (the group dirs — core/llm/shell/… — are pure containers with no manifest).
const workspaceGlobs = [
  { dir: 'vendor', depth: 1 },
  { dir: 'packages', depth: 2 },
  { dir: 'native', depth: 1 },
  { dir: 'native/landlock-run/packages', depth: 1 },
  { dir: 'apps', depth: 1 },
] as const
const vendoredPackages = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/cordis-plugin-hmr',
  '@deepseek-ai/cordis-plugin-logger-console',
])
const publicLandlockPackages = new Set([
  '@deepseek-ai/node-addon-landlock-run',
  '@deepseek-ai/node-addon-landlock-run-linux-arm64',
  '@deepseek-ai/node-addon-landlock-run-linux-x64',
])
/** Deliberate source payloads whose exact bytes are part of the package's audit surface. */
const publicationSourceAllowlist: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/node-addon-landlock-run': ['src/main.c'],
}
const repositoryUrl = 'git+https://github.com/deepseek-harness/deepseek-harness.git'
/**
 * Source home the published packages point consumers at. It differs from
 * {@link repositoryUrl}, which the Landlock packages keep because npm resolves
 * their trusted publishing against the repository that runs the workflow.
 */
const publishedRepositoryUrl = 'git+https://github.com/deepseek-ai/deepseek-harness.git'
/** Private packages that participate in workspace checks but not releases. */
const experimentalPackageDirectory = /^packages\/experimental\/[^/]+$/
/** npm namespace reserved for private experimental packages. */
const experimentalPackageNamePrefix = '@deepseek-ai/dsh-experimental-'
/** Directories whose packages this repository publishes: one release member each. */
const releaseMemberDirectory = /^(?:packages\/(?!experimental\/)[^/]+\/[^/]+|apps\/[^/]+|vendor\/[^/]+)$/
const localArtifactDirs = new Set(['node_modules'])
const appPackageFiles: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh': ['lib/*.js'],
  // Sourcemaps stay out by payload policy; the worker-preview surface
  // (dist/preview.html and dist/preview/) backs private experimental
  // packages and is not published.
  '@deepseek-ai/dsh-web-frontend': ['dist', '!dist/**/*.map', '!dist/preview.html', '!dist/preview'],
}

/** The subset of package.json fields this constraint check cares about. */
export interface PackageManifest {
  name?: string
  version?: string
  private?: boolean
  type?: string
  main?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: Record<
    string,
    | string
    | {
      types?: string
      default?: string
    }
    | null
    | undefined
  >
  files?: string[]
  scripts?: Record<string, string>
  publishConfig?: { access?: string }
  repository?: { type?: string; url?: string; directory?: string }
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dsh?: {
    bundle?: {
      patch?: string
    }
  }
}

/** One workspace manifest and its repo-relative path. */
export interface WorkspaceManifest {
  dir: string
  manifest: PackageManifest
}

function readJson(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

const rootManifest = readJson(join(root, 'package.json'))
const repositoryVersion = rootManifest.version
const landlockWorkspaceManifest = readJson(join(root, 'native/landlock-run/package.json'))
const landlockVersion = landlockWorkspaceManifest.version

/** Repo-relative dirs holding a package.json, walked to the configured depth. */
function packageDirs(base: string, depth: number): string[] {
  if (depth === 1) {
    return readdirSync(join(root, base), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .filter(entry => !localArtifactDirs.has(entry.name))
      .filter(entry => existsSync(join(root, base, entry.name, 'package.json')))
      .map(entry => `${base}/${entry.name}`)
  }
  return readdirSync(join(root, base), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => !localArtifactDirs.has(entry.name))
    .flatMap(group => packageDirs(`${base}/${group.name}`, depth - 1))
}

function workspaceManifests(): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [
    { dir: '.', manifest: rootManifest },
  ]

  for (const { dir: base, depth } of workspaceGlobs) {
    for (const dir of packageDirs(base, depth)) {
      manifests.push({ dir, manifest: readJson(join(root, dir, 'package.json')) })
    }
  }

  return manifests
}

const packageFileExtras: Readonly<Record<string, readonly string[]>> = {
  // Statically linked client libraries keep their stylesheets next to the emitted
  // JavaScript, which imports them by relative path: the compile shell runs
  // them through its own CSS pipeline, so the sheets are published artifacts.
  // The glob covers whichever sheets a package emits; sourcemaps stay
  // unpublished, as everywhere else in the repository.
  '@deepseek-ai/dsh-client-ui-primitives': ['lib/**/*.css'],
  '@deepseek-ai/dsh-client-web': ['lib/**/*.css'],
  '@deepseek-ai/dsh-client-ui-theme': ['lib/styles'],
  // The CPython side ships as source .py files, published as-is rather than built.
  '@deepseek-ai/dsh-code-runtime-python': ['py/**/*.py'],
  // The shipped preset compositions travel inside the roster package.
  '@deepseek-ai/dsh-agent-presets': ['presets'],
  // The Web Host mounts the default-off settings owner independently of each
  // Agent-scoped delegation-tool instance.
  '@deepseek-ai/dsh-tool-subagent': ['lib/model-selection-settings.js'],
  // The argv-prefix runner entry ships beside the lib as its own bundle;
  // sandbox-local resolves it through the package's ./runner export. tsdown
  // also shares its generated FFI code through a hashed runtime chunk.
  '@deepseek-ai/dsh-sandbox-windows-acl': ['lib/runner.js', 'lib/types-*.js'],
  // SQLite loads its compression dictionary and every statement from immutable
  // package resources at runtime.
  '@deepseek-ai/dsh-session-persistence-sqlite': [
    'resources/zstd-dictionary.bin',
    'resources/sql/**/*.sql',
  ],
  '@deepseek-ai/dsh-skill-badge': ['assets'],
  // tsdown shares the repository/pack code between the lib entry and the bin
  // through a hashed chunk. The committed bin.js is the link target bun can
  // resolve at install time, before the build produces lib/bin.js.
  '@deepseek-ai/dsh-experimental-webworker-packer': ['bin.js', 'lib/repository-*.js'],
  '@deepseek-ai/dsh-subprocess-local': ['scripts/ensure-spawn-helper.mjs'],
}

function sameStringList(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return !!actual && actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

export function expectedDshPackageFiles(manifest: PackageManifest): readonly string[] {
  const declaredPatch = manifest.dsh?.bundle?.patch
  const bundleFiles = declaredPatch === undefined ? [] : [declaredPatch.replace(/^\.\//, '')]
  const extras = [
    ...bundleFiles,
    ...(manifest.name ? packageFileExtras[manifest.name] ?? [] : []),
  ]
  return [
    'lib/index.js',
    // Every package publishes its invariant ownership companion as a separate
    // bundle; the package-invariant gate validates the companion itself.
    'lib/invariant.js',
    ...manifest.bin ? ['lib/bin.js'] : [],
    // Worker-thread packages ship a CJS worker entry; the browser worker
    // bundle is an ES module a page loads with `new Worker(type: 'module')`.
    // Keyed on the artifact path, like ./client below.
    ...exportDefault(manifest, './worker') === './lib/worker.cjs' ? ['lib/worker.cjs'] : [],
    ...exportDefault(manifest, './worker') === './lib/worker.js' ? ['lib/worker.js'] : [],
    // UI plugin packages ship their browser bundle beside the node lib
    // (single-artifact ruling: dist/ retired, ./client resolves lib/client.js).
    // Keyed on the artifact path, not the subpath name: a package's ./client is
    // a browser-safe source channel, not a bundle.
    ...exportDefault(manifest, './client') === './lib/client.js' ? ['lib/client.js'] : [],
    // runtime's shell-held loader subpath ships as its own bundle beside the client half.
    ...exportDefault(manifest, './loader') === './lib/loader.js' ? ['lib/loader.js'] : [],
    // A store subpath ships its own bundle (single-entry builds; no shared chunk).
    ...exportDefault(manifest, './store') === './lib/store/index.js' ? ['lib/store/index.js'] : [],
    // A surface bundle's startup row is its own bundle: the Loader imports it
    // as a row module, so it cannot ride inside the package entry.
    ...exportDefault(manifest, './startup') === './lib/startup.js' ? ['lib/startup.js'] : [],
    ...extras,
    // Subpaths whose runtime default is the tsc-emitted tree (lib/types/*.js —
    // browser-safe source channels rehomed off src so plain Node can import
    // them without type stripping) publish the emitted JS alongside the
    // declarations.
    ...usesEmittedTreeDefaults(manifest) ? ['lib/types/**/*.js'] : [],
    'lib/types/**/*.d.ts',
    ...hasExportPair(manifest, './typert', './lib/typert.host.d.ts', './lib/typert.host.js')
      ? ['lib/typert.host.js', 'lib/typert.host.d.ts']
      : [],
    ...hasExportPair(manifest, './client/typert', './lib/typert.client.d.ts', './lib/typert.client.js')
      ? ['lib/typert.client.js', 'lib/typert.client.d.ts']
      : [],
    ...hasTypertRemoteNavigation(manifest)
      ? ['lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts']
      : [],
  ]
}

/** Whether one conditional export exactly names the generated runtime and declaration pair. */
function hasExportPair(
  manifest: PackageManifest,
  subpath: string,
  types: string,
  runtime: string,
): boolean {
  const entry = manifest.exports?.[subpath]
  return typeof entry === 'object'
    && entry !== null
    && entry.types === types
    && entry.default === runtime
}

/** Runtime target of an export entry: conditional `default`, or the bare-string shorthand. */
function exportDefault(manifest: PackageManifest, subpath: string): string | undefined {
  const entry = manifest.exports?.[subpath]
  if (typeof entry === 'string') return entry
  if (typeof entry === 'object' && entry !== null) return entry.default
  return undefined
}

/** Whether any export's runtime default points into the tsc-emitted lib/types tree. */
function usesEmittedTreeDefaults(manifest: PackageManifest): boolean {
  return Object.keys(manifest.exports ?? {}).some(subpath =>
    exportDefault(manifest, subpath)?.startsWith('./lib/types/') === true)
}

/** Experimental manifest requirements enforced independently from release metadata. */
export function checkExperimentalManifest({ dir, manifest }: WorkspaceManifest): string[] {
  if (!experimentalPackageDirectory.test(dir)) return []
  const label = manifest.name ?? dir
  const errors: string[] = []
  if (manifest.name?.startsWith(experimentalPackageNamePrefix) !== true) {
    errors.push(`${label}: experimental package name must start with ${JSON.stringify(experimentalPackageNamePrefix)}`)
  }
  if (manifest.private !== true) errors.push(`${label}: experimental package must set "private": true`)
  if (manifest.publishConfig !== undefined) errors.push(`${label}: experimental package must omit publishConfig`)
  return errors
}

/**
 * Check one workspace manifest against publication and dsh-package policy.
 * @param workspace - package directory and parsed manifest.
 * @returns path-qualified policy violations.
 */
export function checkWorkspaceManifest({ dir, manifest }: WorkspaceManifest): string[] {
  const errors = checkExperimentalManifest({ dir, manifest })
  const label = manifest.name ?? dir
  const isLandlockPackageDir = dir.startsWith('native/landlock-run/packages/')
  const isPublicLandlockPackage = isLandlockPackageDir
    && manifest.name !== undefined
    && publicLandlockPackages.has(manifest.name)

  if (isPublicLandlockPackage) {
    if (manifest.private === true) {
      errors.push(`${label}: published Landlock package must not set "private": true`)
    }
    if (manifest.publishConfig?.access !== 'public') {
      errors.push(`${label}: published Landlock package must set publishConfig.access to "public"`)
    }
    const expectedDirectory = dir
    if (manifest.repository?.type !== 'git'
      || manifest.repository.url !== repositoryUrl
      || manifest.repository.directory !== expectedDirectory) {
      errors.push(`${label}: published Landlock package repository must use ${repositoryUrl} with directory ${expectedDirectory} for trusted publishing`)
    }
  } else if (releaseMemberDirectory.test(dir)) {
    // Release members state that they are publishable: npm refuses a private
    // package, and the repository field is how a consumer finds the source of
    // the package it installed.
    //
    // Access is per release sequence, not per scope: the vendored framework and
    // the Landlock packages publish publicly because outside consumers install
    // them, while the dsh family stays restricted until its own sequence goes
    // public. A mixed scope is why no publish path passes `--access` — one flag
    // cannot serve both, so each packed manifest decides
    // ([rationale](../.agents/notes/implemented/process/2026-08-13-public-vendor-and-native-sequences.md)).
    if (manifest.private === true) {
      errors.push(`${label}: release member must not set "private": true`)
    }
    if (manifest.publishConfig?.access !== 'public') {
      errors.push(`${label}: release member must set publishConfig.access to "public"`)
    }
    if (manifest.repository?.type !== 'git'
      || manifest.repository.url !== publishedRepositoryUrl
      || manifest.repository.directory !== dir) {
      errors.push(`${label}: release member repository must use ${publishedRepositoryUrl} with directory ${dir}`)
    }
  } else if (!experimentalPackageDirectory.test(dir) && manifest.private !== true) {
    errors.push(`${label}: package.json must set "private": true`)
  }

  if (manifest.name && vendoredPackages.has(manifest.name)) {
    return errors
  }

  if (manifest.name?.startsWith('@deepseek-ai/')) {
    const allowedSources = publicationSourceAllowlist[manifest.name] ?? []
    for (const file of manifest.files ?? []) {
      if (isForbiddenPublicationFile(file) && !allowedSources.includes(file)) {
        errors.push(`${label}: package.json files must not publish ${JSON.stringify(file)}`)
      }
    }
  }

  if (dir.startsWith('apps/') && manifest.name?.startsWith('@deepseek-ai/')) {
    const expectedFiles = appPackageFiles[manifest.name]
    if (expectedFiles === undefined) {
      errors.push(`${label}: app package has no publication files policy`)
    } else if (!sameStringList(manifest.files, expectedFiles)) {
      errors.push(`${label}: package.json files must be ${JSON.stringify(expectedFiles)}`)
    }
  }

  if (isLandlockPackageDir) {
    if (!isPublicLandlockPackage) {
      errors.push(`${label}: unexpected package in the public Landlock package family`)
    }
    if (manifest.version !== landlockVersion) {
      errors.push(`${label}: package.json version must match Landlock workspace version ${landlockVersion ?? '(missing)'}`)
    }
  }

  if (dir.startsWith('packages/') && manifest.name?.startsWith('@deepseek-ai/dsh-')) {
    const peer = manifest.peerDependencies?.['@deepseek-ai/cordis']
    const dev = manifest.devDependencies?.['@deepseek-ai/cordis']

    if (!peer) errors.push(`${label}: @deepseek-ai/cordis must be a peerDependency`)
    if (!dev) errors.push(`${label}: @deepseek-ai/cordis must also be a devDependency`)
    if (peer && dev && peer !== dev) {
      errors.push(`${label}: @deepseek-ai/cordis peer (${peer}) and dev (${dev}) ranges must match`)
    }
    if (manifest.version !== repositoryVersion) {
      errors.push(`${label}: package.json version must match root version ${repositoryVersion ?? '(missing)'}`)
    }
    if (manifest.type !== 'module') {
      errors.push(`${label}: package.json must set "type": "module"`)
    }
    if (manifest.main !== 'lib/index.js') {
      errors.push(`${label}: package.json must set "main": "lib/index.js"`)
    }
    if (manifest.types !== 'lib/types/index.d.ts') {
      errors.push(`${label}: package.json must set "types": "lib/types/index.d.ts"`)
    }
    const rootExport = manifest.exports?.['.']
    const rootEntry = typeof rootExport === 'object' && rootExport !== null ? rootExport : undefined
    if (rootEntry?.types !== './lib/types/index.d.ts') {
      errors.push(`${label}: package.json exports["."].types must be "./lib/types/index.d.ts"`)
    }
    if (rootEntry?.default !== './lib/index.js') {
      errors.push(`${label}: package.json exports["."].default must be "./lib/index.js"`)
    }
    const invariantRaw = manifest.exports?.['./invariant']
    const invariantExport = typeof invariantRaw === 'object' && invariantRaw !== null ? invariantRaw : undefined
    if (invariantExport?.types !== undefined && invariantExport.types !== './lib/types/invariant.d.ts') {
      errors.push(`${label}: package.json exports["./invariant"].types must be "./lib/types/invariant.d.ts"`)
    }
    if (invariantExport?.default !== undefined && invariantExport.default !== './lib/invariant.js') {
      errors.push(`${label}: package.json exports["./invariant"].default must be "./lib/invariant.js"`)
    }
    if (invariantExport && (invariantExport.types === undefined || invariantExport.default === undefined)) {
      errors.push(`${label}: package.json exports["./invariant"] must declare both types and default targets`)
    }
    const expectedFiles = expectedDshPackageFiles(manifest)
    if (!sameStringList(manifest.files, expectedFiles)) {
      errors.push(`${label}: package.json files must be ${JSON.stringify(expectedFiles)}`)
    }
  }

  return errors.map(error => `${relative(root, join(root, dir, 'package.json'))}: ${error}`)
}

/**
 * Enforce `packages/<group>/<pkg>`: groups are open-named containers without a
 * package.json, and packages may be neither flat nor more deeply nested.
 */
function checkHierarchyShape(): string[] {
  const errors: string[] = []
  const packagesRoot = join(root, 'packages')
  for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupRel = join('packages', group.name)
    if (existsSync(join(packagesRoot, group.name, 'package.json'))) {
      errors.push(`${groupRel}: a group dir must not contain a package.json — packages live at packages/<group>/<pkg>, not directly under packages/`)
      continue
    }
    for (const pkg of readdirSync(join(packagesRoot, group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      if (localArtifactDirs.has(pkg.name)) continue
      const pkgRel = join(groupRel, pkg.name)
      if (!existsSync(join(packagesRoot, group.name, pkg.name, 'package.json'))) {
        errors.push(`${pkgRel}: expected a package here (no package.json found) — the hierarchy is exactly packages/<group>/<pkg>, no deeper nesting`)
      }
    }
  }
  return errors
}

/** Config file names a package may compile its own sources under. */
const projectConfigGlobs = [
  'packages/*/*/tsconfig*.json',
  'apps/*/tsconfig*.json',
  'vendor/*/tsconfig*.json',
] as const

/** The `compilerOptions` a project config declares for itself, before `extends` resolution. */
interface ProjectCompilerOptions {
  readonly compilerOptions?: {
    readonly outDir?: unknown
    readonly rootDir?: unknown
  }
}

/**
 * Reject one project that emits without pinning its output root.
 *
 * Left inferred, TypeScript derives the layout from the common source
 * directory of the program's inputs, so one file outside `src` — a spec, a
 * fixture — moves the whole emit down a level and the bundler's
 * `lib/types/*.js` entries stop resolving. A stale `lib/` hides that
 * locally; a clean checkout fails the build.
 *
 * @param configPath - Repo-relative config path the diagnostic names.
 * @param config - Parsed config, read as written rather than through `extends`.
 * @returns One diagnostic, or none when the project does not emit or pins `rootDir`.
 */
export function checkProjectRootDir(configPath: string, config: ProjectCompilerOptions): string[] {
  const options = config.compilerOptions
  if (typeof options?.outDir !== 'string' || typeof options.rootDir === 'string') return []
  return [`${configPath}: a project with "outDir" must pin "rootDir" — an inferred root moves the emit whenever an input lands outside it`]
}

/** Apply {@link checkProjectRootDir} to every workspace project config. */
function checkEmittingProjectRootDirs(): string[] {
  return globSync(projectConfigGlobs, { cwd: root }).flatMap(configPath =>
    checkProjectRootDir(configPath, (readConfigFile(join(root, configPath)).config ?? {}) as ProjectCompilerOptions)).sort()
}

function checkRepositoryVersion(): string[] {
  // The root carries the dsh release family's version, so a prerelease such as
  // 0.0.1-rc.1 is a valid state between `release:dsh` and its publication.
  if (repositoryVersion && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(repositoryVersion)) return []
  return ['package.json: version must be X.Y.Z with an optional prerelease segment']
}

/** Dependency sections whose ranges reach a published tarball or a local install. */
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
/** Dependency sections present in an installed runtime. */
const runtimeDependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/**
 * Prevent an official runtime from requiring a package its release omits.
 * @param manifests - release, private experimental, and deployment-root manifests.
 * @returns One error for each forbidden runtime dependency.
 */
export function checkExperimentalDependencyIsolation(manifests: readonly WorkspaceManifest[]): string[] {
  const experimentalNames = new Set(manifests
    .filter(entry => experimentalPackageDirectory.test(entry.dir))
    .map(entry => entry.manifest.name)
    .filter(name => name !== undefined))
  const errors: string[] = []
  for (const { dir, manifest } of manifests) {
    if (!releaseMemberDirectory.test(dir) && dir !== 'python/sdk-runtime') continue
    for (const section of runtimeDependencySections) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (!experimentalNames.has(name)) continue
        errors.push(`${manifest.name ?? dir}: ${section}.${name} must not reference an experimental package`)
      }
    }
  }
  return errors
}

/**
 * Require the `workspace:` protocol for every reference to a workspace member.
 *
 * A hand-written range says nothing about the version the workspace actually
 * carries, and `bun pm pack` leaves it alone: `^0.0.1` published from version
 * `0.0.2` names a version that does not exist. The protocol makes pack
 * substitute the member's real version, so no release step rewrites ranges.
 * @param manifests - every workspace manifest.
 * @returns One error per reference that names a workspace member without the protocol.
 */
function checkWorkspaceProtocol(manifests: readonly WorkspaceManifest[]): string[] {
  const members = new Set(manifests.map(entry => entry.manifest.name).filter(name => name !== undefined))
  const errors: string[] = []
  for (const { dir, manifest } of manifests) {
    for (const section of dependencySections) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (!members.has(name) || range.startsWith('workspace:')) continue
        errors.push(`${manifest.name ?? dir}: ${section}.${name} must use the workspace: protocol, got ${range}`)
      }
    }
  }
  return errors
}

/**
 * Base version a range names, with its comparator removed.
 * @param range - dependency range as declared.
 * @returns the version the range is built on.
 */
function baseVersion(range: string): string {
  return range.replace(/^[\^~><=\s]+/, '')
}

/**
 * Hold every workspace manifest to one version of each external dependency.
 *
 * Two versions of the same package in one install is two copies of its types,
 * its singletons, and its validators, and the bundles that carry both are the
 * ones where that stops being theoretical. An exact pin and a caret on the same
 * base version are the same choice written twice, so only the base version is
 * compared. `vendor/` is exempt: those manifests are pinned copies of upstream
 * and move only through the sync procedure in `vendor/README.md`.
 * @param manifests - every workspace manifest.
 * @returns one error per dependency declared at more than one version.
 */
export function checkSingleExternalVersion(manifests: readonly WorkspaceManifest[]): string[] {
  const members = new Set(manifests.map(entry => entry.manifest.name).filter(name => name !== undefined))
  const declared = new Map<string, Map<string, string[]>>()
  for (const { dir, manifest } of manifests) {
    if (dir === 'vendor' || dir.startsWith('vendor/')) continue
    for (const section of dependencySections) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (members.has(name) || /^(?:workspace|catalog|file|link|npm|portal):/.test(range)) continue
        const versions = declared.get(name) ?? new Map<string, string[]>()
        const holders = versions.get(baseVersion(range)) ?? []
        holders.push(manifest.name ?? dir)
        versions.set(baseVersion(range), holders)
        declared.set(name, versions)
      }
    }
  }
  const errors: string[] = []
  for (const [name, versions] of [...declared].sort(([left], [right]) => left.localeCompare(right))) {
    if (versions.size < 2) continue
    const spread = [...versions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([version, holders]) => `${version} (${[...new Set(holders)].sort().join(', ')})`)
      .join(' vs ')
    errors.push(`${name}: one workspace version only, got ${spread}`)
  }
  return errors
}

/**
 * Keep the build-tooling bootstrap pass ahead of the plugin-bearing Host pass.
 *
 * Node resolves the Typert plugin's whole import graph while `tsdown.config.ts`
 * loads, before that build writes anything, so every workspace package the
 * graph reaches must already carry its `lib/index.js` bundle.
 * `tsdown.bootstrap.config.ts` writes exactly those bundles; dropping it from
 * the script, or running it second, fails the build on any tree that has no
 * output from an earlier build.
 * @param scripts - the root manifest's `scripts` map.
 * @returns one error when the Host lib script omits either pass or orders them wrongly.
 */
export function checkBuildToolingBootstrap(scripts: Record<string, string> | undefined): string[] {
  const label = 'package.json: scripts["build:lib:host"]'
  const script = scripts?.['build:lib:host']
  if (script === undefined) return [`${label} is missing`]
  const bootstrap = script.indexOf('tsdown --config tsdown.bootstrap.config.ts')
  const host = script.indexOf('tsdown --env.DSH_BUILD_FACE host')
  if (host === -1) return [`${label} must run \`tsdown --env.DSH_BUILD_FACE host\``]
  if (bootstrap === -1) {
    return [
      `${label} must run \`tsdown --config tsdown.bootstrap.config.ts\` first: the Host pass cannot load its `
      + 'config until the build tooling\'s workspace dependencies carry their bundles',
    ]
  }
  if (bootstrap > host) return [`${label} must run the bootstrap pass before the Host pass`]
  return []
}

/** Run the repository constraint gate. */
export function main(): void {
  const manifests = workspaceManifests()
  const dependencyManifests = [
    ...manifests,
    { dir: 'python/sdk-runtime', manifest: readJson(join(root, 'python/sdk-runtime/package.json')) },
  ]
  const errors = [
    ...checkRepositoryVersion(),
    ...manifests.flatMap(checkWorkspaceManifest),
    ...checkWorkspaceProtocol(manifests),
    ...checkSingleExternalVersion(manifests),
    ...checkExperimentalDependencyIsolation(dependencyManifests),
    ...checkHierarchyShape(),
    ...collectProjectReferenceFaceViolations(root),
    ...checkEmittingProjectRootDirs(),
    ...checkBuildToolingBootstrap(rootManifest.scripts),
  ]
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
