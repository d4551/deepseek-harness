/**
 * Validate Cordis Loader entry metadata and package resolution.
 *
 * The Loader interpolates a plugin entry's `config` (after declared injections
 * activate, against that plugin context) and the entry `disabled` field (at
 * every mount decision, against the loader context). Every other entry
 * metadata field stays static, so an expression there remains truthy data and
 * silently changes composition. Shipped and test-only dsh overlays resolve
 * named plugins from the CLI application's owning manifest; package-owned
 * Loader fixtures resolve from their package manifest.
 */

import { optionalStringRecord as readStringRecord } from './manifest-fields.ts'
import { globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { cordisConfigFiles } from './cordis-config-files.ts'
import { loadCordisYaml, type CordisObject } from './cordis-yaml.ts'
import { collectImportedSpecifiers } from './verify-cordis-config-imports.ts'
import { metadataExpressionErrors as metadataErrors } from './verify-cordis-config-metadata.ts'
import {
  forEachLoaderEntry,
  validateClientHalvesDeclared as clientHalves,
  validatePresetPlaneSeparation as presetPlanes,
  type ClientHalvesManifest,
} from './verify-cordis-config-planes.ts'
import {
  loadBasePaths,
  resolveSpecifierThroughPaths,
} from './verify-cordis-config-paths.ts'
import { readConfigFile, type JsonValue } from './ts7-session.ts'

/** Project a parsed package.json onto the two fields the client-halves check reads. */
export function manifestToHalves(manifest: PackageManifest): ClientHalvesManifest {
  const record = manifest as Record<string, JsonValue | undefined>
  const exportsField = record.exports
  const dshField = record.dsh
  const exportsObject = exportsField === undefined || exportsField === null
    || typeof exportsField !== 'object' || Array.isArray(exportsField) ? undefined : exportsField
  const dshObject = dshField === undefined || dshField === null
    || typeof dshField !== 'object' || Array.isArray(dshField) ? undefined : dshField
  return {
    ...exportsObject === undefined ? {} : { exports: exportsObject },
    ...dshObject === undefined ? {} : { dsh: dshObject },
  }
}

export interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

export interface PluginReference {
  file: string
  name: string
}

const root = resolve(import.meta.dirname, '..')
const appOverlayFiles = new Set([
  ...globSync('apps/cli/config/examples/**/*.yml', { cwd: root }),
])
const CHOOSER_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-auto'
const CHOOSER_BACKEND_PACKAGES = [
  '@deepseek-ai/dsh-host-directory-picker-native',
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
]
const errors: string[] = []
const pluginReferences: PluginReference[] = []

/** @see {@link ./verify-cordis-config-metadata.ts} */
export function metadataExpressionErrors(entry: CordisObject, path: string): string[] {
  return metadataErrors(entry, path)
}

if (import.meta.main) {
  const files = cordisConfigFiles(root)
  for (const file of files) {
    const document = loadCordisYaml(readFileSync(resolve(root, file), 'utf8'))
    if (!Array.isArray(document)) {
      errors.push(`${file}: root must be a Loader entry array`)
      continue
    }
    for (let index = 0; index < document.length; index++) {
      const item = document[index]
      forEachLoaderEntry(item === undefined ? null : item, file, `[${index}]`, recordAndValidate)
    }
  }
  errors.push(...validateAppResolution())
  errors.push(...validatePackageTestResolution())
  errors.push(...packageTestFixtureDependencyErrors())
  errors.push(...validateSourcePlaneResolution())
  errors.push(...presetPlanes(root))
  errors.push(...clientHalves(root, path => manifestToHalves(readManifest(path))))
  if (errors.length > 0) {
    process.stderr.write('verify-cordis-config: invalid Loader metadata or plugin package resolution:\n')
    for (const error of errors) process.stderr.write(`- ${error}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`verify-cordis-config: ${String(files.length)} config files passed.\n`)
  }
}

function recordAndValidate(entry: CordisObject, file: string, path: string) {
  const name = entry.name
  if (typeof name === 'string') pluginReferences.push({ file, name })
  for (const problem of metadataExpressionErrors(entry, path)) errors.push(`${file}${problem}`)
}

function validateAppResolution(): string[] {
  const violations: string[] = []
  const appManifest = readManifest('apps/cli/package.json')
  const appDependencies: Record<string, string> = { ...appManifest.dependencies }
  for (const file of globSync('packages/bundle/*/package.json', { cwd: root })) {
    Object.assign(appDependencies, readManifest(file).dependencies ?? {})
  }
  const shipped = new Set(globSync('*.cordis.yml', { cwd: resolve(root, 'apps/cli/config') })
    .map(file => `apps/cli/config/${file}`))
  const appReferences = pluginReferences.filter(reference => shipped.has(reference.file) || appOverlayFiles.has(reference.file))
  violations.push(...missingPluginDependencies(
    appReferences,
    appDependencies,
    'apps/cli/package.json dependencies or a bundle manifest',
  ))
  const appTestReferences = pluginReferences.filter(reference => reference.file.startsWith('apps/cli/tests/'))
  violations.push(...missingPluginDependencies(
    appTestReferences,
    { ...appManifest.dependencies, ...appManifest.devDependencies },
    'apps/cli/package.json dependencies or devDependencies',
  ))
  for (const manifestPath of bundleManifestPaths()) {
    const bundleDir = manifestPath.replace(/\/package\.json$/, '')
    const manifest = readManifest(manifestPath)
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string') continue
    const patchFile = relative(root, resolve(root, bundleDir, patch)).replaceAll('\\', '/')
    const references = pluginReferences.filter(reference => reference.file === patchFile)
    violations.push(...bundlePluginDependencyErrors(manifestPath, manifest, references))
  }
  return violations
}

/**
 * Package-owned Loader fixtures resolve named plugins from their package's
 * dependency surface, not from a repository-level test umbrella.
 * @returns one violation per configured package absent from the owner manifest.
 */
function validatePackageTestResolution(): string[] {
  const referencesByManifest = new Map<string, PluginReference[]>()
  for (const reference of pluginReferences) {
    const manifestPath = packageTestManifestPath(reference.file)
    if (manifestPath === undefined) continue
    const references = referencesByManifest.get(manifestPath) ?? []
    references.push(reference)
    referencesByManifest.set(manifestPath, references)
  }
  return [...referencesByManifest].flatMap(([manifestPath, references]) =>
    packageTestPluginDependencyErrors(manifestPath, readManifest(manifestPath), references))
}

/**
 * Validate the named plugins one package-owned Loader fixture resolves.
 * Self-references use Node package self-resolution; every other package must
 * be an ordinary production or test dependency of the owner.
 * @param manifestPath Repository-relative owner manifest path.
 * @param manifest Parsed owner manifest.
 * @param references Named plugin references from owner-local test configs.
 * @returns Missing dependency diagnostics.
 */
export function packageTestPluginDependencyErrors(
  manifestPath: string,
  manifest: PackageManifest,
  references: readonly PluginReference[],
): string[] {
  return missingPluginDependencies(
    references.filter(reference => packageNameFromSpecifier(reference.name) !== manifest.name),
    { ...manifest.dependencies, ...manifest.devDependencies },
    `${manifestPath} dependencies or devDependencies`,
  )
}

/**
 * Validate imports made by fixture modules adjacent to package-owned Loader
 * configs. These files execute as plain Node/tsx children, so a stale root
 * `node_modules` link must not hide an undeclared dependency.
 * @param repoRoot Repository root to scan.
 * @returns Missing dependency diagnostics.
 */
export function packageTestFixtureDependencyErrors(repoRoot: string = root): string[] {
  const fixtureDirectories = new Set(cordisConfigFiles(repoRoot)
    .filter(file => packageTestManifestPath(file) !== undefined)
    .map(file => dirname(file).replaceAll('\\', '/')))
  if (fixtureDirectories.size === 0) {
    return ['package test fixture dependency scan found no package-owned Loader configs']
  }
  const referencesByManifest = new Map<string, PluginReference[]>()
  let fixtureModuleCount = 0
  for (const fixtureDirectory of fixtureDirectories) {
    const files = globSync([
      `${fixtureDirectory}/**/*.ts`,
      `${fixtureDirectory}/**/*.mjs`,
    ], { cwd: repoRoot })
    fixtureModuleCount += files.length
    for (const file of files) {
      const manifestPath = packageTestManifestPath(file)
      if (manifestPath === undefined) continue
      const references = referencesByManifest.get(manifestPath) ?? []
      const source = readFileSync(resolve(repoRoot, file), 'utf8')
      for (const imported of collectImportedSpecifiers(file, source)) {
        references.push({ file: file.replaceAll('\\', '/'), name: imported })
      }
      referencesByManifest.set(manifestPath, references)
    }
  }
  if (fixtureModuleCount === 0) {
    return ['package test fixture dependency scan found no fixture modules beside Loader configs']
  }
  return [...referencesByManifest].flatMap(([manifestPath, references]) =>
    packageTestPluginDependencyErrors(manifestPath, readManifest(manifestPath, repoRoot), references))
}

function packageTestManifestPath(file: string): string | undefined {
  const match = /^(packages\/[^/]+\/[^/]+)\/tests(?:\/|$)/.exec(file.replaceAll('\\', '/'))
  return match?.[1] === undefined ? undefined : `${match[1]}/package.json`
}

/**
 * Discover workspace Bundle packages from their manifest declaration.
 * @param repoRoot Repository root to scan.
 * @returns Sorted slash-normalized repository-relative package manifest paths.
 */
export function bundleManifestPaths(repoRoot: string = root): string[] {
  return globSync('packages/*/*/package.json', { cwd: repoRoot })
    .filter(path => typeof readManifest(path, repoRoot).dsh?.bundle?.patch === 'string')
    .map(path => path.replaceAll('\\', '/'))
    .sort()
}

/**
 * Validate plugin packages referenced by one Bundle patch.
 * @param manifestPath Repository-relative Bundle manifest path.
 * @param manifest Parsed Bundle manifest.
 * @param references Plugin rows read from the Bundle package directory.
 * @returns Missing production dependency diagnostics.
 */
export function bundlePluginDependencyErrors(
  manifestPath: string,
  manifest: PackageManifest,
  references: readonly PluginReference[],
): string[] {
  return missingPluginDependencies(
    references.filter(reference => packageNameFromSpecifier(reference.name) !== manifest.name),
    manifest.dependencies ?? {},
    `${manifestPath} dependencies`,
  )
}

function validateSourcePlaneResolution(): string[] {
  const violations: string[] = []
  const localPackages = localPackageDirectories()
  const loaded = loadBasePaths(root)
  if ('error' in loaded) throw new Error(loaded.error)
  const paths = loaded.paths
  const locationsBySpecifier = new Map<string, Set<string>>()
  for (const reference of pluginReferences) {
    const packageName = packageNameFromSpecifier(reference.name)
    if (packageName === undefined || !localPackages.has(packageName)) continue
    const locations = locationsBySpecifier.get(reference.name) ?? new Set<string>()
    locations.add(reference.file)
    locationsBySpecifier.set(reference.name, locations)
  }
  for (const [specifier, locations] of locationsBySpecifier) {
    if (resolveSpecifierThroughPaths(specifier, paths, root) !== undefined) continue
    violations.push(`${[...locations].join(', ')}: ${specifier} does not resolve to workspace source through tsconfig.base.json paths (add a mapping so the tsx source launch does not depend on built lib/)`)
  }
  return violations
}

function missingPluginDependencies(
  references: readonly PluginReference[],
  dependencies: Readonly<Record<string, string>>,
  dependencyOwner: string,
): string[] {
  const requiredPackages = new Map<string, Set<string>>()
  const require = (packageName: string, file: string) => {
    const locations = requiredPackages.get(packageName) ?? new Set<string>()
    locations.add(file)
    requiredPackages.set(packageName, locations)
  }
  for (const reference of references) {
    const packageName = packageNameFromSpecifier(reference.name)
    if (packageName === undefined) continue
    require(packageName, reference.file)
    if (packageName === CHOOSER_PACKAGE) {
      for (const backend of CHOOSER_BACKEND_PACKAGES) require(backend, reference.file)
    }
  }
  return [...requiredPackages].flatMap(([packageName, locations]) => packageName in dependencies
    ? []
    : `${[...locations].join(', ')}: ${packageName} must be declared in ${dependencyOwner}`)
}

function optionalString(record: JsonValue, key: string): string | undefined {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function optionalStringRecord(record: JsonValue, key: string): Record<string, string> {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return {}
  return readStringRecord(record, key)
}

function readManifest(path: string, repoRoot: string = root): PackageManifest {
  const result = readConfigFile(resolve(repoRoot, path))
  if (result.error !== undefined) throw new Error(result.error.messageText)
  const config = result.config
  if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${path} is not a JSON object`)
  }
  const name = optionalString(config, 'name')
  const dsh = config.dsh
  const bundle = dsh !== undefined && dsh !== null && typeof dsh === 'object' && !Array.isArray(dsh)
    ? dsh.bundle
    : undefined
  const patch = bundle !== undefined && bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle)
    ? bundle.patch
    : undefined
  return {
    ...name === undefined ? {} : { name },
    dependencies: optionalStringRecord(config, 'dependencies'),
    devDependencies: optionalStringRecord(config, 'devDependencies'),
    optionalDependencies: optionalStringRecord(config, 'optionalDependencies'),
    ...typeof patch === 'string' ? { dsh: { bundle: { patch } } } : {},
  }
}

function localPackageDirectories(): Map<string, string> {
  const manifests = globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root })
  const packages = new Map<string, string>()
  for (const manifestPath of manifests) {
    const manifest = readManifest(manifestPath)
    if (manifest.name !== undefined) packages.set(manifest.name, resolve(root, dirname(manifestPath)))
  }
  return packages
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || /^[a-z][a-z+.-]*:/i.test(specifier)) return undefined
  const segments = specifier.split('/')
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined
  }
  return segments[0] === '' ? undefined : segments[0]
}
