/**
 * The barrel ban fails on both forwarding forms and leaves an owning module
 * alone. Injected fixtures prove each case fires; the live tree is scanned as
 * well, so a clean tree is not the only passing case.
 */
import { describe, expect, it } from 'vitest'
import { auditBarrels, barrelCandidateFiles, scanBarrels } from './no-barrels.ts'

describe('injected barrels', () => {
  it('rejects a star re-export even in a module that owns declarations', () => {
    const source = [
      "export * from './types.ts'",
      'export const NAME = \'plugin\'',
    ].join('\n')
    expect(scanBarrels('packages/a/b/src/index.ts', source)).toEqual([{
      file: 'packages/a/b/src/index.ts',
      kind: 'star-re-export',
      detail: 'forwards every symbol of ./types.ts; import that module directly, or publish it as a subpath export',
    }])
  })

  it('rejects `export * as ns from`, which forwards the same unnamed surface', () => {
    const findings = scanBarrels('packages/a/b/src/index.ts', "export * as codec from './codec.ts'\nexport const NAME = 'x'\n")
    expect(findings.map(finding => finding.kind)).toEqual(['star-re-export'])
  })

  it('rejects a module that declares nothing and only forwards', () => {
    const source = [
      "export { alpha } from './alpha.ts'",
      "export type { Beta } from './beta.ts'",
    ].join('\n')
    expect(scanBarrels('packages/a/b/src/index.ts', source)).toEqual([{
      file: 'packages/a/b/src/index.ts',
      kind: 'pure-barrel',
      detail: 'declares nothing and only forwards ./alpha.ts, ./beta.ts; delete it and import the owning module',
    }])
  })

  it('rejects a multi-line named forward block with no own declaration', () => {
    const source = 'export {\n  alpha,\n  beta,\n} from \'./pair.ts\'\n'
    expect(scanBarrels('packages/a/b/src/index.ts', source).map(finding => finding.kind)).toEqual(['pure-barrel'])
  })

  it('accepts a module that owns its API and names a few forwarded symbols', () => {
    const source = [
      "export { Config } from './config.ts'",
      "import type { Context } from '@deepseek-ai/cordis'",
      '/** Mount the plugin. @param ctx - host context. @returns the disposer. */',
      'export function apply(ctx: Context): () => void {',
      '  return () => { void ctx }',
      '}',
    ].join('\n')
    expect(scanBarrels('packages/a/b/src/index.ts', source)).toEqual([])
  })

  it('accepts a module whose only export is its own declaration', () => {
    expect(scanBarrels('packages/a/b/src/types.ts', 'export interface Alpha { id: string }\n')).toEqual([])
  })

  it('ignores a re-export spelled inside a comment or a template literal', () => {
    const source = [
      "/* export * from './ghost.ts' */",
      "// export { ghost } from './ghost.ts'",
      'export const DOC = `export * from \'./ghost.ts\'`',
    ].join('\n')
    expect(scanBarrels('packages/a/b/src/docs.ts', source)).toEqual([])
  })
})

describe('live tree', () => {
  const files = barrelCandidateFiles()

  it('scans a real corpus rather than an empty one', () => {
    expect(files.length).toBeGreaterThan(1000)
    expect(files.some(entry => entry.file.startsWith('packages/core/'))).toBe(true)
    expect(files.some(entry => entry.file.startsWith('scripts/'))).toBe(true)
  })

  it('excludes built output and vendored sources, which this repository does not author', () => {
    expect(files.some(entry => entry.file.includes('/lib/'))).toBe(false)
    expect(files.some(entry => entry.file.startsWith('vendor/'))).toBe(false)
  })

  it('holds no barrels', () => {
    expect(auditBarrels()).toEqual([])
  })
})
