/**
 * Live-stack floors fail when a declared range regresses or product UI
 * admits Tailwind / daisyUI / htmx. Injected misses fail; a clean tree is
 * not the only passing case.
 */
import { describe, expect, it } from 'vitest'
import { version, versionMajorMinor } from 'typescript'
import {
  AXE_FLOOR,
  auditStackMisses,
  declaredRange,
  forbiddenStackHits,
  MCP_SDK_FLOOR,
  parseRangeFloor,
  productUiFiles,
  rangeMeetsFloor,
  rangeMisses,
  reactMisses,
  REACT_FLOOR,
  TYPESCRIPT_FLOOR,
  typescriptCompileMisses,
  viteMisses,
  VITE_FLOOR,
  workspaceManifests,
} from './live-stack-floors.ts'

describe('parseRangeFloor', () => {
  it('reads the encoded version from a caret range', () => {
    expect(parseRangeFloor('^7.0.2')).toEqual({ major: 7, minor: 0, patch: 2 })
    expect(parseRangeFloor('~18.3.1')).toEqual({ major: 18, minor: 3, patch: 1 })
  })

  it('rejects an unparseable range rather than treating it as current', () => {
    expect(() => parseRangeFloor('latest')).toThrow(/unparseable/)
  })
})

describe('injected floor misses', () => {
  it('fails a TypeScript 6 compile pin', () => {
    const misses = rangeMisses('package.json', '{"devDependencies":{"typescript":"^6.0.2"}}', {
      typescript: TYPESCRIPT_FLOOR,
    })
    expect(misses).toEqual([{
      file: 'package.json',
      name: 'typescript',
      range: '^6.0.2',
      floor: TYPESCRIPT_FLOOR,
    }])
  })

  it('fails React 18 and axe below 4.13 and MCP SDK below 1.30', () => {
    const source = JSON.stringify({
      dependencies: {
        react: '^18.2.0',
        'axe-core': '^4.12.0',
        '@modelcontextprotocol/sdk': '^1.12.0',
      },
    })
    expect(rangeMisses('x/package.json', source, { react: REACT_FLOOR }).map(m => m.range)).toEqual(['^18.2.0'])
    expect(rangeMisses('x/package.json', source, { 'axe-core': AXE_FLOOR }).map(m => m.range)).toEqual(['^4.12.0'])
    expect(rangeMisses('x/package.json', source, { '@modelcontextprotocol/sdk': MCP_SDK_FLOOR }).map(m => m.range))
      .toEqual(['^1.12.0'])
  })

  it('fails Vite 6 on the web app', () => {
    const misses = rangeMisses('apps/web/package.json', '{"devDependencies":{"vite":"^6.0.0"}}', { vite: VITE_FLOOR })
    expect(misses.map(m => m.range)).toEqual(['^6.0.0'])
  })

  it('does not treat a missing name as a pass that hid a pin', () => {
    expect(declaredRange('{"devDependencies":{}}', 'typescript')).toBeUndefined()
    expect(rangeMeetsFloor('^19.2.8', REACT_FLOOR)).toBe(true)
  })
})

describe('forbidden stacks', () => {
  it('fails injected daisyUI, Tailwind, and htmx product UI', () => {
    const hits = forbiddenStackHits([
      { file: 'packages/client/ui-chat/src/x.tsx', content: "import 'daisyui'\n" },
      { file: 'packages/client/ui-chat/src/y.css', content: '@tailwind base;\n' },
      { file: 'apps/web/src/z.ts', content: "import 'htmx.org'\n" },
      { file: 'apps/web/index.html', content: '<div hx-get="/x"></div>\n' },
    ])
    expect(hits.map(h => h.token).sort()).toEqual(['@tailwind', 'daisyui', 'htmx.org', 'hx-get'])
  })

  it('does not fire on a clean snippet', () => {
    expect(forbiddenStackHits([{ file: 'packages/client/ui-chat/src/x.tsx', content: 'export const n = 1\n' }])).toEqual([])
  })
})

describe('live workspace floors', () => {
  const manifests = workspaceManifests()

  it('reads the workspace rather than passing on an empty glob', () => {
    expect(manifests.length).toBeGreaterThan(20)
    expect(manifests.some(m => m.file === 'package.json')).toBe(true)
    expect(manifests.some(m => m.file === 'apps/web/package.json')).toBe(true)
  })

  it('holds every typescript compile pin at 7.0.2 or newer', () => {
    expect(typescriptCompileMisses(manifests)).toEqual([])
  })

  it('holds React 19.2.8, Vite 8.2.2 (except VitePress), axe-core 4.13, and MCP SDK 1.30', () => {
    expect(reactMisses(manifests)).toEqual([])
    expect(viteMisses(manifests)).toEqual([])
    expect(auditStackMisses(manifests)).toEqual([])
  })

  it('leaves no Tailwind, daisyUI, or htmx in product UI source', () => {
    const files = productUiFiles()
    expect(files.length).toBeGreaterThan(50)
    expect(forbiddenStackHits(files)).toEqual([])
  })

  it('loads the installed TypeScript 7 compiler, not a mocked version string', () => {
    expect(versionMajorMinor).toBe('7.0')
    expect(version.startsWith('7.')).toBe(true)
    expect(rangeMeetsFloor(`^${version}`, TYPESCRIPT_FLOOR)).toBe(true)
  })
})
