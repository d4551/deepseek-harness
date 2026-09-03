/**
 * The barrel ban fails on both forwarding forms and leaves an owning module
 * alone. Injected fixtures prove each case fires; the live tree is scanned as
 * well, so a clean tree is not the only passing case.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { auditBarrels, barrelCandidateFiles, isPublishedEntry, scanBarrels } from './no-barrels.ts'

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

  it('rejects `export type * from`, which forwards an unnamed type surface', () => {
    const findings = scanBarrels('packages/a/b/src/client.ts', "export type * from './types.ts'\nexport const NS = 'x'\n")
    expect(findings.map(finding => finding.kind)).toEqual(['star-re-export'])
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

  it('accepts a module that declares a type alias beside a forwarded one', () => {
    const source = [
      "export type { Busy } from '../settings.ts'",
      'export type SubmitMode = Busy',
    ].join('\n')
    expect(scanBarrels('packages/a/b/src/contract.ts', source)).toEqual([])
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

describe('published-entry detection', () => {
  const root = resolve(import.meta.dirname, '..')

  it('does not treat a path that merely appears in the manifest text as an export target', () => {
    // `files` and `scripts` also name lib paths; only the exports map publishes.
    expect(auditBarrels()).toEqual([])
  })

  it('recognizes a package entry the exports map publishes', () => {
    expect(isPublishedEntry('packages/subprocess/win32-process/src/index.ts', root)).toBe(true)
  })

  it('recognizes a Client entry the build flattens to the same emitted stem', () => {
    // `src/client/index.ts` emits as `lib/client.js`, which is what `./client` names.
    expect(isPublishedEntry('packages/client/ui-tool/src/client/index.ts', root)).toBe(true)
  })

  it('exempts no internal module of a package whose exports map carries a ./src/* wildcard', () => {
    // The wildcard exists so a sibling can deep-import a source module. It
    // resolves to the literal './src/*', which equals no emitted stem, so it
    // must not turn the whole source tree into published entries — that would
    // disable the pure-barrel rule everywhere instead of at the boundary.
    const manifest = resolve(root, 'packages/subprocess/win32-process/package.json')
    const targets = JSON.parse(readFileSync(manifest, 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(targets.exports)).toContain('./src/*')
    for (const internal of ['ffi.ts', 'errors.ts', 'abi.ts', 'process.ts']) {
      expect(isPublishedEntry(`packages/subprocess/win32-process/src/${internal}`, root), internal).toBe(false)
    }
  })

  it('exempts nothing in a directory that is not a package', () => {
    expect(isPublishedEntry('scripts/no-barrels.ts', root)).toBe(false)
  })
})

describe('live tree', () => {
  const files = barrelCandidateFiles()

  it('scans a real corpus rather than an empty one', () => {
    expect(files.length).toBeGreaterThan(1000)
    expect(files.some(entry => entry.file.startsWith('packages/core/'))).toBe(true)
    expect(files.some(entry => entry.file.startsWith('scripts/'))).toBe(true)
  })

  it('holds no barrels', () => {
    expect(auditBarrels()).toEqual([])
  })
})
