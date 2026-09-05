/** Toolchain floor gate: downgrade detection against the root and web manifests. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUN_PIN,
  NODE_ENGINE_FLOOR,
  TOOLCHAIN_FLOORS,
  checkToolchainFloors,
  rangeMeetsFloor,
} from './verify-toolchain-floors.ts'
import { collectorFloorDisagreements, LIVE_TOOLCHAIN_FLOORS } from './live-stack-floors.ts'

const ROOT_MANIFEST = {
  name: '@deepseek-ai/dsh-root',
  engines: { node: NODE_ENGINE_FLOOR },
  packageManager: BUN_PIN,
  devDependencies: {
    typescript: '^7.0.2',
    vite: '^8.2.2',
    vitest: '^5.0.0',
    tsx: '^4.23.13',
  },
}

const WEB_MANIFEST = {
  devDependencies: {
    react: '~19.2.8',
    'react-dom': '~19.2.8',
    playwright: '^1.62.1',
  },
}

describe('rangeMeetsFloor', () => {
  it('accepts the current toolchain ranges', () => {
    for (const [range, floor] of [
      ['^7.0.2', TOOLCHAIN_FLOORS['typescript']],
      ['~19.2.8', TOOLCHAIN_FLOORS['react']],
      ['^1.62.1', TOOLCHAIN_FLOORS['playwright']],
      ['^4.23.13', TOOLCHAIN_FLOORS['tsx']],
      ['^5.0.0', TOOLCHAIN_FLOORS['vitest']],
    ] as const) {
      expect(rangeMeetsFloor(range, floor), range).toBe(true)
    }
  })

  it('rejects old-major and old-minor bases and unparsable ranges', () => {
    expect(rangeMeetsFloor('^6.9.9', TOOLCHAIN_FLOORS['typescript'])).toBe(false)
    expect(rangeMeetsFloor('^8.1.9', TOOLCHAIN_FLOORS['vite'])).toBe(false)
    expect(rangeMeetsFloor('^4.1.11', TOOLCHAIN_FLOORS['vitest'])).toBe(false)
    expect(rangeMeetsFloor('workspace:^', TOOLCHAIN_FLOORS['vitest'])).toBe(false)
    expect(rangeMeetsFloor('*', TOOLCHAIN_FLOORS['tsx'])).toBe(false)
  })

  it('accepts a higher major as untested-but-new, not a floor miss', () => {
    expect(rangeMeetsFloor('^8.0.0', TOOLCHAIN_FLOORS['typescript'])).toBe(true)
  })
})

describe('checkToolchainFloors', () => {
  it('passes the split root/web toolchain pins', () => {
    expect(checkToolchainFloors(ROOT_MANIFEST, WEB_MANIFEST)).toEqual([])
  })

  it('fails a coordinated downgrade of every toolchain range', () => {
    const findings = checkToolchainFloors({
      ...ROOT_MANIFEST,
      devDependencies: {
        typescript: '^6.0.2',
        vite: '^7.2.2',
        vitest: '^4.1.11',
        tsx: '^3.19.13',
      },
    }, {
      devDependencies: {
        react: '~18.2.8',
        'react-dom': '~18.2.8',
        playwright: '^1.50.0',
      },
    })
    expect(findings.map(finding => finding.subject).sort()).toEqual([
      'apps/web devDependencies.playwright',
      'apps/web devDependencies.react',
      'apps/web devDependencies.react-dom',
      'root devDependencies.tsx',
      'root devDependencies.typescript',
      'root devDependencies.vite',
      'root devDependencies.vitest',
    ])
  })

  it('fails an unpinned engine, bun, or entry absent from every manifest', () => {
    const { tsx: _removed, ...rootDeps } = ROOT_MANIFEST.devDependencies
    const findings = checkToolchainFloors({
      ...ROOT_MANIFEST,
      engines: { node: '^20.0.0' },
      packageManager: 'bun@1.2.0',
      devDependencies: rootDeps,
    }, WEB_MANIFEST)
    expect(findings.map(finding => finding.subject).sort()).toEqual([
      'dependencies/devDependencies.tsx',
      'engines.node',
      'packageManager',
    ])
  })

  it('fails a bun 1.3.x packageManager pin', () => {
    const findings = checkToolchainFloors({
      ...ROOT_MANIFEST,
      packageManager: 'bun@1.3.11',
    }, WEB_MANIFEST)
    expect(findings.some(finding => finding.subject === 'packageManager' && finding.declared.includes('1.3.11'))).toBe(true)
  })

  it('holds the live root and web manifests, not only the in-spec fixtures', () => {
    const root = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as Record<string, unknown>
    const web = JSON.parse(readFileSync(resolve(import.meta.dirname, '../apps/web/package.json'), 'utf8')) as Record<string, unknown>
    expect(checkToolchainFloors(root, web)).toEqual([])
    expect(root['packageManager']).toBe(BUN_PIN)
  })

  it('derives its (major, minor) floors from the live-stack SemVer triples', () => {
    expect(collectorFloorDisagreements(LIVE_TOOLCHAIN_FLOORS, TOOLCHAIN_FLOORS)).toEqual([])
  })
})
