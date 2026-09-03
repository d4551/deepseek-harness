/**
 * Declared-range floors for the live compile and client stack, plus the
 * product-UI ban on Tailwind / daisyUI / htmx. Tests inject a violating
 * manifest or source snippet; a clean tree is not the only passing case.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { uniqueRepoFiles } from './repo-files.ts'

/** One three-part version used as a floor, never as a copied expected blob. */
export interface SemVer {
  major: number
  minor: number
  patch: number
}

/** One declared dependency range that sits below its floor. */
export interface RangeMiss {
  /** Repository-relative package.json path. */
  file: string
  /** Dependency name. */
  name: string
  /** Range string as declared. */
  range: string
  /** Floor the range must meet. */
  floor: SemVer
}

/** One product-UI hit of a forbidden CSS/JS stack. */
export interface ForbiddenHit {
  /** Repository-relative path. */
  file: string
  /** Matched token. */
  token: string
}

const ROOT = resolve(import.meta.dirname, '..')

/** TypeScript compile pin (not `@typescript/typescript6`, which is Strada). */
export const TYPESCRIPT_FLOOR: SemVer = { major: 7, minor: 0, patch: 2 }
/** React product pin. */
export const REACT_FLOOR: SemVer = { major: 19, minor: 2, patch: 8 }
/** react-dom product pin. */
const REACT_DOM_FLOOR: SemVer = { major: 19, minor: 2, patch: 8 }
/** @types/react product pin. */
const TYPES_REACT_FLOOR: SemVer = { major: 19, minor: 2, patch: 18 }
/** @types/react-dom product pin. */
const TYPES_REACT_DOM_FLOOR: SemVer = { major: 19, minor: 2, patch: 5 }
/** Vite pin for the web app and the repo root (VitePress on the website is exempt). */
export const VITE_FLOOR: SemVer = { major: 8, minor: 2, patch: 2 }
/** @vitejs/plugin-react pin for the web app. */
const PLUGIN_REACT_FLOOR: SemVer = { major: 6, minor: 1, patch: 1 }
/** axe-core pin. */
export const AXE_FLOOR: SemVer = { major: 4, minor: 13, patch: 0 }
/** @modelcontextprotocol/sdk v1 latest. */
export const MCP_SDK_FLOOR: SemVer = { major: 1, minor: 30, patch: 0 }
/** Oxlint pin: the repository's only linter. */
const OXLINT_FLOOR: SemVer = { major: 1, minor: 81, patch: 0 }
/**
 * `oxlint-tsgolint` pin. This is the type-aware half of the lint gate — the
 * `no-unsafe-*` and `no-unnecessary-condition` rules that hold the TypeScript 7
 * conversion honest all come from it. An older build still lints and still
 * exits zero while checking less, so the floor is what keeps the gate from
 * silently weakening.
 */
const OXLINT_TSGOLINT_FLOOR: SemVer = { major: 7, minor: 0, patch: 2001 }
/** Vitest pin: the runner every lane configures. */
const VITEST_FLOOR: SemVer = { major: 4, minor: 1, patch: 11 }
/** `@types/node` pin: the ambient surface every Host package compiles against. */
const TYPES_NODE_FLOOR: SemVer = { major: 26, minor: 4, patch: 0 }
/**
 * `tsx` pin. The `dsh` source launch runs through tsx's ESM-only hook, so this
 * is a named part of the source-launch contract rather than a test-only tool.
 */
const TSX_FLOOR: SemVer = { major: 4, minor: 23, patch: 13 }
/** Coverage reporter pin: versioned in lockstep with {@link VITEST_FLOOR}. */
const COVERAGE_V8_FLOOR: SemVer = { major: 4, minor: 1, patch: 11 }
/** `@testing-library/react` pin: every Client component suite renders through it. */
const TESTING_LIBRARY_REACT_FLOOR: SemVer = { major: 16, minor: 3, patch: 3 }
/** `execa` pin: the subprocess surface the CLI and loader smokes drive. */
const EXECA_FLOOR: SemVer = { major: 10, minor: 0, patch: 1 }
/** `zod` pin: the validation surface 31 manifests declare. */
const ZOD_FLOOR: SemVer = { major: 4, minor: 5, patch: 4 }
/** `clsx` pin: class composition in every Client component. */
const CLSX_FLOOR: SemVer = { major: 2, minor: 1, patch: 1 }
/** `yaml` pin: the Cordis config parser. */
const YAML_FLOOR: SemVer = { major: 2, minor: 9, patch: 0 }
/** `fflate` pin: session-transcript compression. */
const FFLATE_FLOOR: SemVer = { major: 0, minor: 8, patch: 3 }
/** `playwright` pin: the browser the Web snapshot and e2e lanes drive. */
const PLAYWRIGHT_FLOOR: SemVer = { major: 1, minor: 62, patch: 1 }
/**
 * `railway` pin: the Infrastructure as Code authoring types
 * `deploy/litert/.railway/railway.ts` compiles against. Railway documents the
 * install as an unpinned `npm install railway`, so the version a deployer gets
 * is whatever is current; holding the repository at that same version is what
 * keeps the compile check measuring the API the CLI will evaluate.
 */
const RAILWAY_FLOOR: SemVer = { major: 3, minor: 11, patch: 0 }

/**
 * Every non-workspace dependency the root manifest declares, mapped to the
 * version the repository ships. The root manifest is the toolchain single
 * source of truth: the compiler, bundler, test runner, linter, mutation
 * runner, and documentation tooling all resolve from here, so a stale
 * declaration here weakens every gate below it.
 *
 * This map is complete by construction rather than by memory:
 * {@link unflooredRootDependencies} fails when the manifest declares a
 * dependency this map does not, so adding one forces stating the version it
 * may never fall below. Families that also appear in workspace manifests
 * reuse the exported floor constant rather than repeating the number.
 */
export const ROOT_DEPENDENCY_FLOORS: Readonly<Record<string, SemVer>> = Object.freeze({
  '@babel/core': { major: 8, minor: 0, patch: 1 },
  '@babel/plugin-proposal-decorators': { major: 8, minor: 0, patch: 2 },
  '@babel/plugin-syntax-jsx': { major: 8, minor: 0, patch: 1 },
  '@babel/preset-typescript': { major: 8, minor: 0, patch: 1 },
  '@stryker-mutator/api': { major: 10, minor: 0, patch: 0 },
  '@stryker-mutator/core': { major: 10, minor: 0, patch: 0 },
  '@stryker-mutator/vitest-runner': { major: 10, minor: 0, patch: 0 },
  '@stylistic/eslint-plugin': { major: 5, minor: 10, patch: 0 },
  '@testing-library/dom': { major: 10, minor: 4, patch: 1 },
  '@testing-library/react': TESTING_LIBRARY_REACT_FLOOR,
  '@types/jsdom': { major: 30, minor: 0, patch: 0 },
  '@types/mdast': { major: 4, minor: 0, patch: 4 },
  '@types/node': TYPES_NODE_FLOOR,
  '@types/spdx-expression-parse': { major: 4, minor: 0, patch: 0 },
  '@vitest/coverage-v8': COVERAGE_V8_FLOOR,
  '@yarnpkg/cli-dist': { major: 4, minor: 18, patch: 0 },
  execa: EXECA_FLOOR,
  'fast-check': { major: 4, minor: 9, patch: 0 },
  'istanbul-lib-report': { major: 3, minor: 0, patch: 1 },
  'js-yaml': { major: 5, minor: 4, patch: 1 },
  jscpd: { major: 5, minor: 1, patch: 1 },
  jsdom: { major: 30, minor: 0, patch: 1 },
  'jsonc-parser': { major: 3, minor: 3, patch: 1 },
  knip: { major: 6, minor: 34, patch: 0 },
  lefthook: { major: 2, minor: 1, patch: 12 },
  lightningcss: { major: 1, minor: 33, patch: 0 },
  'mdast-util-from-markdown': { major: 2, minor: 0, patch: 3 },
  'mdast-util-gfm': { major: 3, minor: 1, patch: 0 },
  mermaid: { major: 11, minor: 17, patch: 2 },
  'micromark-extension-gfm': { major: 3, minor: 0, patch: 0 },
  oxlint: OXLINT_FLOOR,
  'oxlint-tsgolint': OXLINT_TSGOLINT_FLOOR,
  publint: { major: 0, minor: 3, patch: 24 },
  railway: RAILWAY_FLOOR,
  'smol-toml': { major: 1, minor: 8, patch: 0 },
  'spdx-expression-parse': { major: 5, minor: 0, patch: 0 },
  tsdown: { major: 0, minor: 22, patch: 14 },
  tsx: TSX_FLOOR,
  typescript: TYPESCRIPT_FLOOR,
  vite: VITE_FLOOR,
  vitest: VITEST_FLOOR,
  'vite-tsconfig-paths': { major: 6, minor: 1, patch: 1 },
})

const FORBIDDEN_STACK = /(\b(?:daisyui|tailwindcss|htmx\.org|hx-(?:get|post|put|patch|delete|swap|trigger|boost|target))\b|@tailwind\b)/g

/**
 * Parse the first `major.minor.patch` in a declared range (`^7.0.2`, `~18.3.1`).
 * @param range - the package.json version string.
 * @returns the numeric floor encoded in the range.
 */
export function parseRangeFloor(range: string): SemVer {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range)
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`unparseable version range: ${range}`)
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Compare two three-part versions.
 * @param a - left.
 * @param b - right.
 * @returns negative when `a < b`, zero when equal, positive when `a > b`.
 */
function cmpSemVer(a: SemVer, b: SemVer): number {
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch)
}

/**
 * Whether a declared range meets a floor.
 * @param range - package.json version string.
 * @param floor - minimum allowed encoded version.
 * @returns true when the range's encoded version is at or above the floor.
 */
export function rangeMeetsFloor(range: string, floor: SemVer): boolean {
  return cmpSemVer(parseRangeFloor(range), floor) >= 0
}

/** Manifest fields whose entries declare a dependency range. */
const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

/**
 * Read a declared dependency range from a package.json document.
 *
 * The lookup reads the dependency groups rather than scanning the raw text:
 * a scan matches the first `"name": "value"` pair anywhere in the file, so a
 * script sharing a dependency's name (`"knip": "knip --treat-config-hints-as-errors"`)
 * is returned as that dependency's version range.
 * @param source - raw package.json text.
 * @param name - dependency name.
 * @returns the range string, or undefined when no group declares the name.
 */
export function declaredRange(source: string, name: string): string | undefined {
  for (const group of dependencyGroups(source)) {
    const range = group[name]
    if (range !== undefined) return range
  }
  return undefined
}

/**
 * Read a manifest's dependency groups as name-to-range records.
 * @param source - raw package.json text.
 * @returns one record per present group, in {@link DEPENDENCY_GROUPS} order.
 */
function dependencyGroups(source: string): Record<string, string>[] {
  const manifest: unknown = JSON.parse(source)
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('package.json is not an object')
  }
  const record = manifest as Record<string, unknown>
  const groups: Record<string, string>[] = []
  for (const field of DEPENDENCY_GROUPS) {
    const group = record[field]
    if (group === undefined) continue
    if (typeof group !== 'object' || group === null || Array.isArray(group)) {
      throw new Error(`package.json ${field} is not an object`)
    }
    const ranges: Record<string, string> = {}
    for (const [name, range] of Object.entries(group as Record<string, unknown>)) {
      if (typeof range !== 'string') throw new Error(`package.json ${field}.${name} is not a string`)
      ranges[name] = range
    }
    groups.push(ranges)
  }
  return groups
}

/**
 * Collect declared ranges that sit below a named floor.
 * @param file - repository-relative package.json path (diagnostics only).
 * @param source - raw package.json text.
 * @param checks - dependency name to floor.
 * @returns every miss.
 */
export function rangeMisses(
  file: string,
  source: string,
  checks: Readonly<Record<string, SemVer>>,
): RangeMiss[] {
  const misses: RangeMiss[] = []
  for (const [name, floor] of Object.entries(checks)) {
    const range = declaredRange(source, name)
    if (range === undefined) continue
    if (rangeMeetsFloor(range, floor)) continue
    misses.push({ file, name, range, floor })
  }
  return misses
}

function isWorkspaceManifest(relativePath: string): boolean {
  if (relativePath.includes('node_modules/')) return true
  if (relativePath.startsWith('vendor/')) return true
  return !relativePath.endsWith('package.json')
}

/**
 * Load every workspace package.json the floors apply to.
 * @param root - repository root.
 * @returns relative path plus raw source.
 */
export function workspaceManifests(root: string = ROOT): { file: string; source: string }[] {
  return uniqueRepoFiles(root, [
    'package.json',
    'apps/*/package.json',
    'packages/*/*/package.json',
    'native/*/package.json',
    'python/*/package.json',
    'website/package.json',
  ], isWorkspaceManifest).map(({ abs }) => {
    const file = abs.slice(root.length + 1).split('\\').join('/')
    return { file, source: readFileSync(abs, 'utf8') }
  })
}

/**
 * TypeScript compile-pin misses (`typescript` only; Strada is a different name).
 * @param manifests - workspace manifests.
 * @returns misses below {@link TYPESCRIPT_FLOOR}.
 */
export function typescriptCompileMisses(manifests: readonly { file: string; source: string }[]): RangeMiss[] {
  return manifests.flatMap(({ file, source }) => rangeMisses(file, source, { typescript: TYPESCRIPT_FLOOR }))
}

/**
 * React / types misses across product manifests.
 * @param manifests - workspace manifests.
 * @returns misses below the React 19 floors.
 */
export function reactMisses(manifests: readonly { file: string; source: string }[]): RangeMiss[] {
  return manifests.flatMap(({ file, source }) => rangeMisses(file, source, {
    react: REACT_FLOOR,
    'react-dom': REACT_DOM_FLOOR,
    '@types/react': TYPES_REACT_FLOOR,
    '@types/react-dom': TYPES_REACT_DOM_FLOOR,
  }))
}

/**
 * Vite / plugin-react misses for the web app and the repo root. VitePress on
 * `website/` stays on Vite 5 by upstream need and is not this floor.
 * @param manifests - workspace manifests.
 * @returns misses below {@link VITE_FLOOR} / {@link PLUGIN_REACT_FLOOR}.
 */
export function viteMisses(manifests: readonly { file: string; source: string }[]): RangeMiss[] {
  return manifests.flatMap(({ file, source }) => {
    if (file.startsWith('website/')) return []
    return rangeMisses(file, source, {
      vite: VITE_FLOOR,
      '@vitejs/plugin-react': PLUGIN_REACT_FLOOR,
    })
  })
}

/**
 * axe-core and MCP SDK misses.
 * @param manifests - workspace manifests.
 * @returns misses below {@link AXE_FLOOR} / {@link MCP_SDK_FLOOR}.
 */
export function auditStackMisses(manifests: readonly { file: string; source: string }[]): RangeMiss[] {
  return manifests.flatMap(({ file, source }) => rangeMisses(file, source, {
    'axe-core': AXE_FLOOR,
    '@modelcontextprotocol/sdk': MCP_SDK_FLOOR,
  }))
}

/**
 * Toolchain misses: the linter, its type-aware plugin, the test runner, and the
 * ambient Node types. These never reach a user, but every other gate's strength
 * is measured by them, so a regression here is a silent loss of coverage.
 * @param manifests - workspace manifests.
 * @returns misses below the toolchain floors.
 */
export function toolchainMisses(manifests: readonly { file: string; source: string }[]): RangeMiss[] {
  return manifests.flatMap(({ file, source }) => rangeMisses(file, source, {
    oxlint: OXLINT_FLOOR,
    'oxlint-tsgolint': OXLINT_TSGOLINT_FLOOR,
    vitest: VITEST_FLOOR,
    '@vitest/coverage-v8': COVERAGE_V8_FLOOR,
    '@types/node': TYPES_NODE_FLOOR,
    tsx: TSX_FLOOR,
    '@testing-library/react': TESTING_LIBRARY_REACT_FLOOR,
    execa: EXECA_FLOOR,
    zod: ZOD_FLOOR,
    clsx: CLSX_FLOOR,
    yaml: YAML_FLOOR,
    fflate: FFLATE_FLOOR,
    playwright: PLAYWRIGHT_FLOOR,
  }))
}

/**
 * Third-party packages a workspace manifest pins to one exact version, mapped
 * to the version the repository ships.
 *
 * An exact pin is the one range that cannot drift upward on its own: a caret
 * range tracks minors, while `"0.149.1"` stays on 0.149.1 until a person
 * changes it, so the pins are where a stack silently rots. These are also the
 * pins that matter most — three of them are third-party *products* the harness
 * drives as subprocesses, whose wire behavior changes between releases and
 * whose fixtures are hand-written mocks of that behavior.
 *
 * Complete by construction, like {@link ROOT_DEPENDENCY_FLOORS}:
 * {@link unflooredPinnedDependencies} fails when a manifest pins a package
 * this map does not name.
 */
export const PINNED_PRODUCT_FLOORS: Readonly<Record<string, SemVer>> = Object.freeze({
  '@agentclientprotocol/sdk': { major: 1, minor: 4, patch: 0 },
  '@types/ws': { major: 8, minor: 18, patch: 1 },
  '@anthropic-ai/claude-agent-sdk': { major: 0, minor: 3, patch: 259 },
  '@anthropic-ai/sdk': { major: 0, minor: 123, patch: 0 },
  '@openai/codex': { major: 0, minor: 153, patch: 0 },
  e2b: { major: 2, minor: 46, patch: 1 },
  'use-sync-external-store': { major: 1, minor: 6, patch: 0 },
  webdav: { major: 5, minor: 10, patch: 0 },
  ws: { major: 8, minor: 21, patch: 3 },
})

/**
 * Every floor an exact pin may be held to.
 *
 * The root manifest states its own toolchain floors, and a workspace manifest
 * that pins a member of a root family is held to the same number rather than
 * repeating it.
 */
const PIN_FLOORS: Readonly<Record<string, SemVer>> = Object.freeze({
  ...ROOT_DEPENDENCY_FLOORS,
  ...PINNED_PRODUCT_FLOORS,
})

/**
 * Every exact-version third-party pin across the workspace manifests.
 *
 * `workspace:` ranges name packages in this repository, whose versions move
 * with the release, and a range with an operator already tracks upstream, so
 * neither is a pin this gate governs.
 *
 * `website/` is excluded: it is a VitePress projection whose dependency set is
 * VitePress's own — including the Vite 5 that VitePress pins, which the Vite 8
 * floor above would otherwise reject. Its stack moves when VitePress moves.
 * @param manifests - repository-relative path plus raw package.json text.
 * @returns one entry per exact pin, in manifest then declaration order.
 */
export function exactPinnedDependencies(
  manifests: readonly { file: string; source: string }[],
): { file: string; name: string; range: string }[] {
  const pins: { file: string; name: string; range: string }[] = []
  for (const { file, source } of manifests) {
    if (file.startsWith('website/')) continue
    for (const group of dependencyGroups(source)) {
      for (const [name, range] of Object.entries(group)) {
        if (name.startsWith('@deepseek-ai/')) continue
        if (!/^\d+\.\d+\.\d+$/.test(range)) continue
        pins.push({ file, name, range })
      }
    }
  }
  return pins
}

/**
 * Locate an installed package's own manifest from the manifest that declares it.
 *
 * `require.resolve` is tried first and is not sufficient on its own: a package
 * whose `exports` map omits `./package.json` refuses that subpath, and the
 * product SDKs pinned here do exactly that. Falling back to the directory on
 * disk keeps them measured rather than silently skipped, which is the shape of
 * hole this check exists to close.
 * @param name - the dependency's package name.
 * @param declaredIn - absolute path of the manifest declaring it.
 * @returns absolute path to the installed package.json, or undefined when the
 *   package is not materialized in this checkout.
 */
function installedManifestOf(name: string, declaredIn: string): string | undefined {
  const from = createRequire(declaredIn)
  try {
    return from.resolve(`${name}/package.json`)
  } catch {
    // The exports map refuses the subpath, or the package is absent; the disk
    // answers both cases below.
  }
  let directory = dirname(declaredIn)
  for (;;) {
    const candidate = resolve(directory, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * The version each exact pin actually resolves to on disk.
 *
 * A manifest states a range; what runs is whatever the lockfile resolved and
 * the linker materialized. Checking only the declaration measures the intent
 * rather than the stack, which is the failure this whole file exists to catch,
 * so the floors are held against both. Resolution starts from the manifest that
 * declares the pin because `bunfig.toml` sets `linker = "isolated"`: a package
 * resolves only its own declared tree, with no root hoist to fall back on.
 * @param manifests - repository-relative path plus raw package.json text.
 * @param root - repository root.
 * @returns one entry per pin whose installed package.json could be read.
 */
export function installedPinVersions(
  manifests: readonly { file: string; source: string }[],
  root: string = ROOT,
): { file: string; name: string; version: string }[] {
  const found: { file: string; name: string; version: string }[] = []
  for (const pin of exactPinnedDependencies(manifests)) {
    const installed = installedManifestOf(pin.name, resolve(root, pin.file))
    if (installed === undefined) continue
    const version = (JSON.parse(readFileSync(installed, 'utf8')) as { version?: string }).version
    if (version !== undefined) found.push({ file: pin.file, name: pin.name, version })
  }
  return found
}

/**
 * Exact pins whose installed version sits below the floor.
 * @param manifests - repository-relative path plus raw package.json text.
 * @param root - repository root.
 * @returns every miss, carrying the version found on disk as its range.
 */
export function installedPinMisses(
  manifests: readonly { file: string; source: string }[],
  root: string = ROOT,
): RangeMiss[] {
  const misses: RangeMiss[] = []
  for (const { file, name, version } of installedPinVersions(manifests, root)) {
    const floor = PIN_FLOORS[name]
    if (floor === undefined) continue
    if (rangeMeetsFloor(version, floor)) continue
    misses.push({ file, name, range: version, floor })
  }
  return misses
}

/**
 * Exact pins that declare no floor, so nothing would notice them going stale.
 * @param manifests - repository-relative path plus raw package.json text.
 * @returns each unflooded pin's manifest path and dependency name.
 */
export function unflooredPinnedDependencies(
  manifests: readonly { file: string; source: string }[],
): { file: string; name: string }[] {
  return exactPinnedDependencies(manifests)
    .filter(pin => !(pin.name in PIN_FLOORS))
    .map(({ file, name }) => ({ file, name }))
}

/**
 * Exact pins sitting below the version the repository ships.
 * @param manifests - repository-relative path plus raw package.json text.
 * @returns every miss against {@link PINNED_PRODUCT_FLOORS}.
 */
export function pinnedDependencyMisses(
  manifests: readonly { file: string; source: string }[],
): RangeMiss[] {
  return manifests
    .filter(({ file }) => !file.startsWith('website/'))
    .flatMap(({ file, source }) => rangeMisses(file, source, PIN_FLOORS))
}

/**
 * Root-manifest dependency names that declare no floor. A dependency added
 * without one would otherwise ship at whatever version its author happened to
 * install and never be checked again.
 * @param source - raw root package.json text.
 * @returns every non-workspace dependency name missing from
 *   {@link ROOT_DEPENDENCY_FLOORS}, in declaration order.
 */
export function unflooredRootDependencies(source: string): string[] {
  return rootDeclaredDependencies(source).filter(name => !(name in ROOT_DEPENDENCY_FLOORS))
}

/**
 * Root-manifest declarations that sit below the version the repository ships.
 * @param source - raw root package.json text.
 * @returns every miss against {@link ROOT_DEPENDENCY_FLOORS}.
 */
export function rootDependencyMisses(source: string): RangeMiss[] {
  return rangeMisses('package.json', source, ROOT_DEPENDENCY_FLOORS)
}

/**
 * Read the root manifest's non-workspace dependency names.
 *
 * `workspace:` ranges name packages in this repository, whose versions move
 * with the release, so a registry floor would describe nothing.
 * @param source - raw root package.json text.
 * @returns dependency names in declaration order.
 */
function rootDeclaredDependencies(source: string): string[] {
  const names: string[] = []
  for (const group of dependencyGroups(source)) {
    for (const [name, range] of Object.entries(group)) {
      if (range.startsWith('workspace:')) continue
      names.push(name)
    }
  }
  return names
}

/**
 * Read the live root manifest.
 * @param root - repository root.
 * @returns raw root package.json text.
 */
export function rootManifestSource(root: string = ROOT): string {
  return readFileSync(resolve(root, 'package.json'), 'utf8')
}

function isProductUiPath(relativePath: string): boolean {
  if (relativePath.includes('/tests/') || relativePath.includes('/lib/')) return false
  if (relativePath.startsWith('packages/client/') && relativePath.includes('/src/')) return true
  // Any package's browser half, wherever it lives: an extension or a prototype
  // ships the same forbidden stacks as `packages/client` would.
  if (/^packages\/[^/]+\/[^/]+\/src\/client\//.test(relativePath)) return true
  if (/^packages\/(?:extensions|experimental)\/[^/]+\/package\.json$/.test(relativePath)) return true
  if (relativePath.startsWith('apps/web/src/')) return true
  if (relativePath === 'apps/web/index.html') return true
  if (relativePath === 'apps/web/package.json') return true
  if (/^packages\/client\/[^/]+\/package\.json$/.test(relativePath)) return true
  return false
}

/**
 * Scan product UI source for Tailwind / daisyUI / htmx tokens.
 * @param files - path plus content (live tree or injected fixture).
 * @returns every hit.
 */
export function forbiddenStackHits(files: readonly { file: string; content: string }[]): ForbiddenHit[] {
  const hits: ForbiddenHit[] = []
  for (const { file, content } of files) {
    FORBIDDEN_STACK.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = FORBIDDEN_STACK.exec(content)) !== null) {
      const token = match[1]
      if (token === undefined) continue
      hits.push({ file, token })
    }
  }
  return hits
}

/**
 * Load product UI files the forbidden-stack scan covers.
 * @param root - repository root.
 * @returns path plus content.
 */
export function productUiFiles(root: string = ROOT): { file: string; content: string }[] {
  return uniqueRepoFiles(root, [
    'packages/client/*/src/**/*.{ts,tsx,css,html}',
    'packages/client/*/package.json',
    // Every browser tree in the repository, not only `packages/client`: an
    // extension or a prototype paints product UI too, and a forbidden stack
    // introduced there would be as shipped as one introduced here.
    'packages/*/*/src/client/**/*.{ts,tsx,css,html}',
    'packages/*/*/package.json',
    'apps/web/src/**/*.{ts,tsx,css,html}',
    'apps/web/index.html',
    'apps/web/package.json',
  ], relativePath => relativePath.includes('node_modules/') || relativePath.startsWith('vendor/'))
    .filter(({ abs }) => isProductUiPath(abs.slice(root.length + 1).split('\\').join('/')))
    .map(({ abs }) => {
      const file = abs.slice(root.length + 1).split('\\').join('/')
      return { file, content: readFileSync(abs, 'utf8') }
    })
}
