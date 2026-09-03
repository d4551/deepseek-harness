/**
 * The source-tree emit ban fires on artifacts that shadow an authored module
 * and leaves standalone scripts alone. Injected trees prove each rule; the live
 * repository is scanned too, so a clean tree is not the only passing case.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditSourceTreeEmits } from './no-source-tree-emits.ts'

/**
 * Build a throwaway repository holding the given files under `packages/`.
 * @param files - path relative to the fake package's `src`, mapped to contents.
 * @returns the fake repository root.
 */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-emits-'))
  const src = join(root, 'packages', 'group', 'pkg', 'src')
  mkdirSync(src, { recursive: true })
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(src, name), contents)
  return root
}

describe('injected artifacts', () => {
  it('rejects a .js that shadows the .ts it was compiled from', () => {
    const findings = auditSourceTreeEmits(fixture({ 'index.ts': 'export const a = 1\n', 'index.js': 'export const a = 1\n' }))
    expect(findings.map(finding => finding.file)).toEqual(['packages/group/pkg/src/index.js'])
  })

  it('rejects an emitted declaration that shadows its module', () => {
    const findings = auditSourceTreeEmits(fixture({ 'index.ts': 'export const a = 1\n', 'index.d.ts': 'export declare const a: number\n' }))
    expect(findings.map(finding => finding.file)).toEqual(['packages/group/pkg/src/index.d.ts'])
  })

  it('rejects a source map whatever sits beside it, because nobody writes one', () => {
    // The stem has no module sibling here: a map is an artifact on its own.
    const findings = auditSourceTreeEmits(fixture({ 'index.js.map': '{"version":3}\n' }))
    expect(findings.map(finding => finding.detail)).toEqual([
      expect.stringContaining('source maps are never authored'),
    ])
  })

  it('accepts a standalone script, which is authored source', () => {
    // Fixtures, bins and config are written as .js/.mjs all over this
    // repository; only shadowing makes one an artifact.
    expect(auditSourceTreeEmits(fixture({ 'bin.js': '#!/usr/bin/env node\n', 'fixture.mjs': 'export default 1\n' }))).toEqual([])
  })

  it('accepts an ambient declaration that stands alone', () => {
    expect(auditSourceTreeEmits(fixture({ 'css-modules.d.ts': "declare module '*.module.css'\n" }))).toEqual([])
  })

  it('accepts a .tsx module beside its own declaration-free source', () => {
    expect(auditSourceTreeEmits(fixture({ 'View.tsx': 'export const View = () => null\n' }))).toEqual([])
  })

  it('rejects a .js shadowing a .tsx, which emits to the same stem', () => {
    const findings = auditSourceTreeEmits(fixture({ 'View.tsx': 'export const View = () => null\n', 'View.js': 'export const View = () => null\n' }))
    expect(findings.map(finding => finding.file)).toEqual(['packages/group/pkg/src/View.js'])
  })
})

describe('live tree', () => {
  it('holds no compiler output beside its sources', () => {
    // A misconfigured program emits in place instead of into its outDir, and
    // Vite then resolves the artifact ahead of the source, so a lane reports
    // results for code that is no longer on disk.
    expect(auditSourceTreeEmits()).toEqual([])
  })
})
