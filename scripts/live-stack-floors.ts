/**
 * Declared-range floors for the live compile and client stack, plus the
 * product-UI ban on Tailwind / daisyUI / htmx. Tests inject a violating
 * manifest or source snippet; a clean tree is not the only passing case.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
const OXLINT_FLOOR: SemVer = { major: 1, minor: 80, patch: 0 }
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

/**
 * Read the first declared range for `name` from a package.json document.
 * @param source - raw package.json text.
 * @param name - dependency name.
 * @returns the range string, or undefined when the name is absent.
 */
export function declaredRange(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`).exec(source)
  return match?.[1]
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
