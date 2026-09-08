import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeTypescriptFile } from './typescript-semantics.ts'

describe('TypeScript 7 cross-file semantic analysis', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-semantics-'))
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'esnext', module: 'nodenext' },
      files: ['consumer.ts', 'contract.ts', 'exports.ts'],
    }))
    writeFileSync(join(directory, 'contract.ts'),
      'export interface Contract { id: string }; export function identity<T>(value: T): T { return value }')
    writeFileSync(join(directory, 'exports.ts'),
      "export { identity as renamed, type Contract as Shape } from './contract.js'")
  })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('resolves renamed re-exports to their declarations and infers generic call results', () => {
    writeFileSync(join(directory, 'consumer.ts'), [
      "import { renamed as local, type Shape } from './exports.js'",
      'const value: Shape = { id: "one" };',
      'const result = local(value);',
      'const id = result.id;',
    ].join('\n'))
    const report = analyzeTypescriptFile(join(directory, 'tsconfig.json'), join(directory, 'consumer.ts'))
    expect(report.diagnostics).toEqual([])
    const imported = report.references.find(reference => reference.name === 'local')
    expect(imported).toMatchObject({ alias: true, symbol: 'identity' })
    expect(imported?.declarations.map(declaration => declaration.file)).toEqual([join(directory, 'contract.ts')])
    expect(report.references.find(reference => reference.name === 'Shape')).toMatchObject({
      alias: true, symbol: 'Contract',
    })
    expect(report.references.find(reference => reference.name === 'id' && reference.type === 'string')).toBeDefined()
    expect(report.references.find(reference => reference.name === 'result')?.type).toBe('Shape')
  })

  it('reports unresolved imports and incompatible assignments as errors', () => {
    writeFileSync(join(directory, 'consumer.ts'),
      "import { missing } from './absent.js'; const count: number = 'wrong'; missing()")
    const report = analyzeTypescriptFile(join(directory, 'tsconfig.json'), join(directory, 'consumer.ts'))
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([2307, 2322]))
    expect(report.references.find(reference => reference.name === 'missing')).toMatchObject({
      alias: true, symbol: null, declarations: [], type: null,
    })
  })

  it('rejects a file outside the selected project', () => {
    writeFileSync(join(directory, 'consumer.ts'), 'export const count = 1')
    writeFileSync(join(directory, 'outside.ts'), 'export const other = 2')
    expect(() => analyzeTypescriptFile(join(directory, 'tsconfig.json'), join(directory, 'outside.ts')))
      .toThrow('does not belong')
  })

  it.each([
    ['export const result = 1', 0],
    ["export const result: number = 'wrong'", 1],
  ])('surfaces compiler diagnostics through the command exit status for %s', (source, status) => {
    writeFileSync(join(directory, 'consumer.ts'), source)
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', join(import.meta.dirname, 'analyze-typescript.ts'),
      join(directory, 'tsconfig.json'), join(directory, 'consumer.ts'),
    ], { encoding: 'utf8' })
    expect(result.status).toBe(status)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('"references":')
    expect(result.stdout).toContain('"diagnostics":')
    if (status === 1) expect(result.stdout).toContain('"code": 2322')
  })
})
