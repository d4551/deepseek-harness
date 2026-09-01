/**
 * Toolchain floor gate: the root manifest's pinned toolchain — engines,
 * packageManager, and the toolchain dependencies the build itself runs on —
 * must stay at or above the current major/minor floor. Coordinated downgrades
 * of caret ranges pass every other gate (bun.lock can be regenerated), so the
 * floor is asserted here against the manifest text.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Minimum accepted (major, minor) per toolchain dependency of the root
 * manifest. `tsx` rides along with the CLI source launch; the web toolchain
 * (typescript, vite, react, playwright, vitest) is what the build and the
 * snapshot lanes execute on.
 */
export const TOOLCHAIN_FLOORS = Object.freeze({
  typescript: [7, 0],
  vite: [8, 2],
  react: [19, 2],
  'react-dom': [19, 2],
  playwright: [1, 62],
  vitest: [4, 1],
  tsx: [4, 23],
} as const satisfies Record<string, readonly [number, number]>)

/** Node engine floor the manifest must declare (CI matrix legs match it). */
export const NODE_ENGINE_FLOOR = '^22.19.0 || >=24.0.0'

/** Exact bun pin the manifest's packageManager field must carry. */
export const BUN_PIN = 'bun@1.4.0'

/** One floor miss. */
export interface ToolchainFinding {
  /** What drifted: `engines.node`, `packageManager`, or a dependency name. */
  subject: string
  /** Declared value (or absent-marker). */
  declared: string
  /** The floor the declaration violates. */
  floor: string
}

/**
 * Compare a semver range against a (major, minor) floor.
 *
 * Only ranges whose every matching version satisfies the floor pass: a caret
 * range's base must be at or above the floor and below the next major above
 * the floor's major (a higher major is an untested toolchain, not a floor
 * miss, and passes).
 * @param range - dependency range as written.
 * @param floor - minimum accepted major.minor.
 * @returns true when the range cannot resolve below the floor.
 */
export function rangeMeetsFloor(range: string, floor: readonly [number, number]): boolean {
  const base = /^(?:\^|~|>=|)\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(range.trim())
  if (base === null) return false
  const major = Number(base[1])
  const minor = Number(base[2])
  if (major < floor[0]) return false
  if (major === floor[0] && minor < floor[1]) return false
  return true
}

/**
 * Check the root manifest plus the web entry (which pins the browser-side
 * toolchain react/playwright) against the toolchain floors.
 *
 * @param rootManifest - parsed root package.json.
 * @param webManifest - parsed apps/web/package.json.
 * @returns every floor miss, empty when the toolchain is current.
 */
export function checkToolchainFloors(
  rootManifest: Record<string, unknown>,
  webManifest: Record<string, unknown> = {},
): ToolchainFinding[] {
  const findings: ToolchainFinding[] = []
  const manifests: readonly { label: string; manifest: Record<string, unknown> }[] = [
    { label: 'root', manifest: rootManifest },
    { label: 'apps/web', manifest: webManifest },
  ]

  const engines = rootManifest['engines'] as Record<string, unknown> | undefined
  const node = engines === undefined ? undefined : engines['node']
  if (typeof node !== 'string' || node !== NODE_ENGINE_FLOOR) {
    findings.push({
      subject: 'engines.node',
      declared: node === undefined ? '(absent)' : JSON.stringify(node),
      floor: NODE_ENGINE_FLOOR,
    })
  }

  const packageManager = rootManifest['packageManager']
  if (packageManager !== BUN_PIN) {
    findings.push({
      subject: 'packageManager',
      declared: packageManager === undefined ? '(absent)' : JSON.stringify(packageManager),
      floor: BUN_PIN,
    })
  }

  const sections = [
    'dependencies',
    'devDependencies',
  ] as const
  for (const { label, manifest } of manifests) {
    for (const section of sections) {
      const deps = manifest[section] as Record<string, unknown> | undefined
      if (deps === undefined) continue
      for (const [name, floor] of Object.entries(TOOLCHAIN_FLOORS)) {
        const declared = deps[name]
        if (declared === undefined) continue
        if (typeof declared !== 'string' || !rangeMeetsFloor(declared, floor)) {
          findings.push({
            subject: `${label} ${section}.${name}`,
            declared: JSON.stringify(declared),
            floor: `^${floor[0]}.${floor[1]}.0`,
          })
        }
      }
    }
  }

  // A toolchain entry missing from every manifest is itself a floor miss:
  // a dependency removed everywhere is a silent downgrade of what CI runs.
  const present = new Set<string>()
  for (const { manifest } of manifests) {
    for (const section of sections) {
      const deps = manifest[section] as Record<string, unknown> | undefined
      if (deps === undefined) continue
      for (const name of Object.keys(TOOLCHAIN_FLOORS)) {
        if (deps[name] !== undefined) present.add(name)
      }
    }
  }
  for (const [name, floor] of Object.entries(TOOLCHAIN_FLOORS)) {
    if (present.has(name)) continue
    findings.push({
      subject: `dependencies/devDependencies.${name}`,
      declared: '(absent)',
      floor: `^${floor[0]}.${floor[1]}.0`,
    })
  }

  return findings
}

/**
 * Verify the live root and web manifests and exit nonzero on any floor miss.
 * @returns exit code, 0 when the toolchain is at or above every floor.
 */
export function verifyToolchainFloors(root: string = ROOT): number {
  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>
  const webManifest = JSON.parse(readFileSync(resolve(root, 'apps/web/package.json'), 'utf8')) as Record<string, unknown>
  const findings = checkToolchainFloors(rootManifest, webManifest)
  for (const finding of findings) {
    console.error(`verify-toolchain-floors: ${finding.subject} is ${finding.declared}, floor is ${finding.floor}`)
  }
  if (findings.length > 0) return 1
  console.log('verify-toolchain-floors: toolchain at or above every floor')
  return 0
}

if (import.meta.main) {
  process.exit(verifyToolchainFloors())
}
