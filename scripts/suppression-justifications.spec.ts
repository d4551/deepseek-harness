import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { loadSuppressionCorpus, scanSuppressions } from './suppression-justifications.ts'

function scan(content: string, file: string = 'packages/x/y/src/index.ts') {
  return scanSuppressions([{ file, content }])
}

describe('scanSuppressions', () => {
  it.each([
    ['oxlint-disable-next-line typescript/unbound-method -- a reason', 'lint-directive'],
    ['eslint-disable-line no-console', 'lint-directive'],
    ['eslint-disable', 'lint-directive'],
    ['tslint-disable-next-line', 'lint-directive'],
    ['biome-ignore lint/suspicious/noExplicitAny: a reason', 'lint-directive'],
    ['biome-ignore-all lint: a reason', 'lint-directive'],
    ['prettier-ignore', 'lint-directive'],
    ['dprint-ignore', 'lint-directive'],
    ['eslint no-console: 0', 'lint-directive'],
    ['eslint no-console: "off"', 'lint-directive'],
    ['eslint no-console: ["off", {}]', 'lint-directive'],
    ['@ts-ignore reason', 'typescript-directive'],
    ['@ts-expect-error reason', 'typescript-directive'],
    ['@ts-nocheck', 'typescript-directive'],
    ['istanbul ignore next -- reason', 'coverage-directive'],
    ['c8 ignore start', 'coverage-directive'],
    ['v8 ignore next 3', 'coverage-directive'],
    ['node:coverage disable', 'coverage-directive'],
    ['Stryker disable all: reason', 'mutation-directive'],
    ['Stryker disable next-line StringLiteral: reason', 'mutation-directive'],
  ])('rejects directive %s with or without an explanation', (directive, kind) => {
    expect(scan(`// Explanation above the directive.\n// ${directive}\nexport const value = 1\n`)).toEqual([
      { file: 'packages/x/y/src/index.ts', line: 2, kind, text: directive },
    ])
  })

  it('finds block comment directives at their physical line numbers', () => {
    expect(scan('/*\n * @ts-nocheck\n * Explanation.\n */\n/* istanbul ignore file */\nexport const value = 1\n'))
      .toEqual([
        { file: 'packages/x/y/src/index.ts', line: 2, kind: 'typescript-directive', text: '* @ts-nocheck' },
        { file: 'packages/x/y/src/index.ts', line: 5, kind: 'coverage-directive', text: 'istanbul ignore file' },
      ])
  })

  it.each([
    'try { run() } catch {}',
    'try { run() } catch { /* A documented reason. */ }',
    'try { run() } catch (error) { report(error) }',
    'try { run() } catch (error) { if (error) { report(error) } throw error }',
  ])('rejects actual catch clause %s', (content) => {
    expect(scan(content)).toEqual([
      { file: 'packages/x/y/src/index.ts', line: 1, kind: 'catch-clause', text: content.slice(content.indexOf('catch')) },
    ])
  })

  it('does not interpret directive or catch text inside strings, regular expressions or templates as syntax', () => {
    expect(scan([
      'const directive = "// oxlint-disable-next-line rule"',
      'const input = "try { run() } catch {}"',
      'const pattern = /catch\\s*\\{\\}/',
      'const directivePattern = /eslint-disable|@ts-ignore|Stryker disable/',
      'const template = `/* istanbul ignore next */\ntry {} catch {}`',
      '// Documentation mentions eslint-disable as a prohibited directive.',
      'export const value = { catch() { return directive + input + template + pattern + directivePattern } }',
    ].join('\n'))).toEqual([])
  })

  it('finds catch syntax inside a template interpolation', () => {
    expect(scan('const output = `${(() => { try { run() } catch { return 0 } })()}`')[0]?.kind).toBe('catch-clause')
  })

  it.each([
    'task.catch((error: unknown) => report(error))',
    'task["catch"](report)',
    'task[`catch`](report)',
    'task?.catch(report)',
    'task.catch?.(report)',
    'task?.["catch"]?.(report)',
    'const reject = task.catch.bind(task)',
    'const reject = task["catch"]',
  ])('rejects catch-handler access %s', (content) => {
    const findings = scan(content)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: 'packages/x/y/src/index.ts', line: 1, kind: 'catch-handler',
    })
  })

  it('does not mistake unrelated property access or catch-handler text for handler access', () => {
    expect(scan([
      'const name = "status"',
      'const described = "task.catch(report)"',
      'const pattern = /\\.catch\\(/',
      'const value = object[name]',
    ].join('\n'))).toEqual([])
  })

  it.each([
    'const handler = "catch"; task[handler](report)',
    'const first = "ca"; const handler = `${first}tch`; task?.[handler](report)',
    'task["ca" + "tch"](report)',
    'const { catch: reject } = task',
    'const { "catch": reject } = task',
    'const handler = "catch"; const { [handler]: reject } = task',
    '({ catch: reject } = task)',
    'function run({ catch: reject }) { return reject(report) }',
    'const { nested: { catch: reject } } = holder',
  ])('rejects resolved or destructured catch-handler access %s', (content) => {
    expect(scan(content)).toEqual([
      expect.objectContaining({ file: 'packages/x/y/src/index.ts', line: 1, kind: 'catch-handler' }),
    ])
  })

  it('resolves computed handlers in their lexical scope', () => {
    expect(scan([
      'const handler = "catch"',
      'function other(handler: string) { return task[handler] }',
      '{ const handler = "then"; task[handler](report) }',
      'task[handler](report)',
    ].join('\n'))).toEqual([
      expect.objectContaining({ file: 'packages/x/y/src/index.ts', line: 4, kind: 'catch-handler' }),
    ])
  })

  it('does not treat property creation or unresolved computed access as proven handler access', () => {
    expect(scan([
      'const object = { catch: report, ["catch"]: report }',
      'const { then: next } = task',
      'function select(key: string) { return task[key] }',
      'let changing = "catch"; changing = "then"; task[changing](report)',
    ].join('\n'))).toEqual([])
  })

  it('reports the handler property line across a multiline chain', () => {
    expect(scan('task\n  .catch(report)')).toEqual([
      { file: 'packages/x/y/src/index.ts', line: 2, kind: 'catch-handler', text: 'catch(report)' },
    ])
  })

  it('accepts supported JSX, declarations, decorators and CommonJS syntax', () => {
    expect(scan('export const view = <p title="@ts-ignore">catch {"{}"}</p>', 'source.tsx')).toEqual([])
    expect(scan('export declare const value: string', 'source.d.ts')).toEqual([])
    expect(scan('@sealed export class Value { @tracked accessor count = 1 }', 'source.ts')).toEqual([])
    expect(scan('module.exports = /@ts-ignore/', 'source.cjs')).toEqual([])
  })

  it('fails closed on unreadable source and an empty corpus', () => {
    expect(() => scanSuppressions([])).toThrow('nonempty')
    expect(() => scan('export const value = (')).toThrow()
    expect(scan('const value = 1; const value = 2;')[0]?.kind).toBe('parse-error')
  })

  it('retains syntax failures and direct handler findings without constructing an invalid scope', () => {
    const findings = scan('const value = 1; const value = 2; task.catch(report)')
    expect(findings.map(finding => finding.kind)).toEqual(['catch-handler', 'parse-error'])
  })

  it('does not execute source callbacks while resolving a computed property', () => {
    expect(scan('const handler = (() => { throw new Error("source executed") })(); task[handler](report)')).toEqual([])
  })

  it.each([
    'const name = "catch" as const; task[name](report)',
    'const name = ("catch" satisfies string)!; task[name](report)',
    'const name = <string>"catch"; task[name](report)',
    'const { name } = { name: "catch" }; task[name](report)',
    'const { name: alias } = { name: "catch" }; task[alias](report)',
    'const [name] = ["catch"]; task[name](report)',
    'const [, name] = ["then", "catch"]; task[name](report)',
    'const { nested: [name] } = { nested: ["catch"] }; task[name](report)',
    'const field = "name"; const { [field]: name } = { name: "catch" }; task[name](report)',
    'const key = "hand" + "ler"; const { [key]: name } = { handler: "catch" }; task[name](report)',
    'const prefix = "hand"; const key = `${prefix}ler`; const { [key]: name } = { handler: "catch" }; task[name](report)',
    'const { name } = { name: "then", name: "catch" }; task[name](report)',
  ])('detects a statically bound handler without evaluating source: %s', (content) => {
    expect(scan(content)).toEqual([expect.objectContaining({ kind: 'catch-handler' })])
  })

  it('reuses immutable alias proofs without expanding a repeated expression tree', () => {
    const aliases = ['const part0 = ""']
    for (let index = 1; index <= 40; index++) {
      aliases.push(`const part${index} = part${index - 1} + part${index - 1}`)
    }
    expect(scan(`${aliases.join('; ')}; task["catch" + part40](report)`))
      .toEqual([expect.objectContaining({ kind: 'catch-handler' })])
  })

  it.each([
    'const slice = "toUpperCase"; task["catch"[slice]()](report)',
    'const toUpperCase = "slice"; task["catch"[toUpperCase]()](report)',
    'task["x".repeat(-1)]',
    'task[false && decodeURIComponent("%")] ',
    'task[String.fromCharCode(99, 97, 116, 99, 104)](report)',
    'task[name](report); const name = "catch"',
    'const name = name; task[name](report)',
    'const first = second; const second = first; task[first](report)',
    'let name = "then"; name = "catch"; task[name](report)',
    'const { name } = { name: "catch", ...other }; task[name](report)',
    'const { name } = { get name() { throw Error("executed") } }; task[name](report)',
    'const holder = { name: "catch" }; holder.name = "then"; const { name } = holder; task[name](report)',
    'const [name] = [...other]; task[name](report)',
    'const { name = "catch" } = other; task[name](report)',
    'const { name } = { name: "catch", name: "then" }; task[name](report)',
  ])('leaves unsupported or unstable computations unproven without executing them: %s', (content) => {
    expect(scan(content)).toEqual([])
  })

  it('normalizes paths and sorts reports by file and line', () => {
    expect(scanSuppressions([
      { file: 'scripts\\z.ts', content: '// @ts-ignore\nconst z = 1' },
      { file: 'scripts\\a.ts', content: '// eslint-disable\nconst a = 1' },
    ]).map(({ file, line }) => ({ file, line }))).toEqual([
      { file: 'scripts/a.ts', line: 1 }, { file: 'scripts/z.ts', line: 1 },
    ])
  })
})

describe('loadSuppressionCorpus', () => {
  async function repository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-directive-scan-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    execFileSync('git', ['init', '--quiet', root])
    return root
  }

  const groups = [
    'packages/a/b/src', 'packages/a/b/tests', 'apps/cli/src', 'apps/cli/tests',
    'scripts', 'snapshots', 'vendor/schema/src', 'native/runner', 'website', '.github', '',
  ]

  it('discovers all authored groups and JavaScript/TypeScript source extensions', async () => {
    const root = await repository()
    const expected: string[] = []
    for (const group of groups) {
      for (const extension of ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']) {
        const file = group === '' ? `config.${extension}` : `${group}/nested/source.${extension}`
        await mkdir(dirname(join(root, file)), { recursive: true })
        await writeFile(join(root, file), '// @ts-nocheck\nexport const value = 1\n')
        expected.push(file)
      }
    }
    execFileSync('git', ['add', 'vendor', 'snapshots'], { cwd: root })
    const extra = 'new-subsystem/runtime.ts'
    await mkdir(dirname(join(root, extra)), { recursive: true })
    await writeFile(join(root, extra), '// @ts-nocheck\nexport const value = 1\n')
    expected.push(extra)
    const corpus = loadSuppressionCorpus(root)
    expect(corpus.map(source => source.file)).toEqual(expected.sort((a, b) => a.localeCompare(b)))
    expect(scanSuppressions(corpus)).toHaveLength(89)
  })

  it.each(groups)('rejects narrowed discovery without %s', async (missing) => {
    const root = await repository()
    for (const group of groups) {
      if (group === missing) continue
      await mkdir(join(root, group), { recursive: true })
      await writeFile(join(root, group, 'index.ts'), 'export const value = 1\n')
    }
    expect(() => loadSuppressionCorpus(root)).toThrow('no authored source found')
  })

  it('rejects an empty repository', async () => {
    const root = await repository()
    expect(() => loadSuppressionCorpus(root)).toThrow('no authored source found')
  })
})

describe('live authored source', () => {
  it('contains no diagnostic directives, catch clauses or catch-handler access', () => {
    const corpus = loadSuppressionCorpus()
    expect(corpus.length).toBeGreaterThan(3000)
    expect(scanSuppressions(corpus)).toEqual([])
  })
})
