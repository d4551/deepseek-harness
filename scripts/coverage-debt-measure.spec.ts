import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { COVERAGE_SOURCE_GLOB } from './coverage-debt.ts'
import { DEBT_REPORTS_DIRECTORY, measureCommand, measureDebt, parseFileTotals, renderDebtMeasure, runDebtMeasure, uncoveredCount } from './coverage-debt-measure.ts'

const complete = 'packages/a/b/src/x.ts\t2/2\t0/0\t1/1\t2/2\n'
const partial = 'packages/a/b/src/y.ts\t1/3\t1/2\t0/1\t1/3\n'

describe('coverage totals', () => {
  it('reads and normalizes counts, including empty metrics', () => {
    const parsed = parseFileTotals(complete.replace('packages/a/b/src/x.ts', 'packages\\a\\b\\src\\x.ts') + partial)
    expect([...parsed.keys()]).toEqual(['packages/a/b/src/x.ts', 'packages/a/b/src/y.ts'])
    expect([...parsed.values()].map(uncoveredCount)).toEqual([0, 6])
  })

  it.each([
    'x.ts\t1/2\t0/0\t0/0',
    'x.ts\t1/2\t0/0\t0/0\t1/2\textra',
    '\t1/2\t0/0\t0/0\t1/2',
    'x.ts\t1 of 2\t0/0\t0/0\t1/2',
    'x.ts\t3/2\t0/0\t0/0\t1/2',
    'x.ts\t9007199254740992/9007199254740992\t0/0\t0/0\t1/2',
    '../x.ts\t1/2\t0/0\t0/0\t1/2',
    '/x.ts\t1/2\t0/0\t0/0\t1/2',
    'C:\\x.ts\t1/2\t0/0\t0/0\t1/2',
    'a//x.ts\t1/2\t0/0\t0/0\t1/2',
  ])('rejects malformed totals %s', (line) => {
    expect(() => parseFileTotals(line)).toThrow()
  })

  it('rejects duplicate records', () => {
    expect(() => parseFileTotals(complete + complete)).toThrow('appears twice')
  })

  it('keeps all source files, including absent measurements', () => {
    const measure = measureDebt(['packages/a/b/src/x.ts', 'packages/a/b/src/y.ts', 'packages/a/b/src/z.ts'], parseFileTotals(complete + partial))
    expect(measure.met).toEqual(['packages/a/b/src/x.ts'])
    expect(measure.open.map(file => file.file)).toEqual(['packages/a/b/src/y.ts'])
    expect(measure.unmeasured).toEqual(['packages/a/b/src/z.ts'])
    expect(renderDebtMeasure(measure)).toBe([
      'coverage-debt measure: 3 source file(s): 1 at 100%, 1 short, 1 unmeasured',
      'below 100% (uncovered statements/branches/functions/lines):',
      '  packages/a/b/src/y.ts  2/1/1/2',
      'unmeasured source files (coverage verification failed):',
      '  packages/a/b/src/z.ts', '',
    ].join('\n'))
  })

  it('rejects empty and repeated source inventories', () => {
    expect(() => measureDebt([], new Map())).toThrow('nonempty and unique')
    expect(() => measureDebt(['a', 'a'], new Map())).toThrow('nonempty and unique')
  })
})

describe('measurement command', () => {
  it('keeps configured thresholds and source selection intact', () => {
    const command = measureCommand('/repo', ['packages/a/b/tests'], { npm_execpath: '/tools/bun' })
    expect(command.command).toBe('/tools/bun')
    expect(command.args).toEqual([
      'x', 'vitest', 'run', '--coverage.enabled', '--coverage.reportOnFailure',
      `--coverage.reporter=${resolve(import.meta.dirname, 'coverage-file-totals.cjs')}`,
      `--coverage.reportsDirectory=${DEBT_REPORTS_DIRECTORY}`, 'packages/a/b/tests',
    ])
    expect(command.env).toEqual({})
  })

  it.each(['--coverage.thresholds.lines=0', '--coverage.exclude=x', '--config=other.ts', '-c', '--coverage=false', ''])('rejects option override %s', (arg) => {
    expect(() => measureCommand('/repo', [arg], { npm_execpath: 'bun' })).toThrow('only positional test paths')
  })
})

describe('real coverage measurement', () => {
  async function repository(source: string, assertion: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coverage-measure-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'packages/a/b/src'), { recursive: true })
    await writeFile(join(root, 'packages/a/b/src/x.ts'), source)
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await symlink(resolve(import.meta.dirname, '../node_modules'), join(root, 'node_modules'), 'dir')
    await writeFile(join(root, 'source.spec.ts'), `import { expect, it } from 'vitest'\nimport { value } from './packages/a/b/src/x.ts'\nit('executes the source', () => { ${assertion} })\n`)
    await writeFile(join(root, 'vitest.config.ts'), `export default { test: { include: ['source.spec.ts'], coverage: {
      provider: 'v8', reportOnFailure: true, autoAttachSubprocess: true, include: ['${COVERAGE_SOURCE_GLOB}'],
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 }
    } } }`)
    return root
  }

  it('requires the real process and every metric to pass', async () => {
    const root = await repository('export const value = () => 7\n', 'expect(value()).toBe(7)')
    const printed: string[] = []
    expect(await runDebtMeasure({ root, environment: { npm_execpath: 'bun' }, out: (text) => { printed.push(text) } })).toBe(0)
    expect(printed.join('')).toBe('coverage-debt measure: 1 source file(s): 1 at 100%, 0 short, 0 unmeasured\n')
  })

  it('collects execution from real child processes and worker threads', async () => {
    const root = await repository('export const value = () => 7\n', 'expect(value()).toBe(7)')
    await writeFile(join(root, 'packages/a/b/src/child.cjs'), 'process.stdout.write("child-result")\n')
    await writeFile(join(root, 'packages/a/b/src/worker.cjs'), 'require("node:worker_threads").parentPort.postMessage("worker-result")\n')
    await writeFile(join(root, 'source.spec.ts'), `
      import { execFileSync } from 'node:child_process'
      import { Worker } from 'node:worker_threads'
      import { fileURLToPath } from 'node:url'
      import { expect, it } from 'vitest'
      import { value } from './packages/a/b/src/x.ts'
      it('executes all three source files', async () => {
        expect(value()).toBe(7)
        const childFile = fileURLToPath(new URL('./packages/a/b/src/child.cjs', import.meta.url))
        expect(execFileSync(process.execPath, [childFile], { encoding: 'utf8' })).toBe('child-result')
        const worker = new Worker(new URL('./packages/a/b/src/worker.cjs', import.meta.url))
        const messages = []
        worker.on('message', message => messages.push(message))
        const code = await new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject) })
        expect(code).toBe(0)
        expect(messages).toEqual(['worker-result'])
      })
    `)
    const printed: string[] = []
    expect(await runDebtMeasure({ root, environment: { npm_execpath: 'bun' }, out: (text) => { printed.push(text) } })).toBe(0)
    const totals = parseFileTotals(await readFile(join(root, DEBT_REPORTS_DIRECTORY, 'file-totals.tsv'), 'utf8'))
    for (const file of ['packages/a/b/src/child.cjs', 'packages/a/b/src/worker.cjs']) {
      expect(totals.get(file)?.statements.covered).toBeGreaterThan(0)
      expect(totals.get(file)?.statements.covered).toBe(totals.get(file)?.statements.total)
    }
    expect(printed.join('')).toBe('coverage-debt measure: 3 source file(s): 3 at 100%, 0 short, 0 unmeasured\n')
  })

  it('fails on an uncovered branch while still printing measured totals', async () => {
    const root = await repository('export const value = (enabled: boolean) => enabled ? 7 : 9\n', 'expect(value(true)).toBe(7)')
    const printed: string[] = []
    expect(await runDebtMeasure({ root, environment: { npm_execpath: 'bun' }, out: (text) => { printed.push(text) } })).toBe(1)
    expect(printed.join('')).toContain('1 source file(s): 0 at 100%, 1 short, 0 unmeasured')
  })

  it('retains declaration files in the canonical inventory and measurement', async () => {
    const root = await repository('export const value = () => 7\n', 'expect(value()).toBe(7)')
    await writeFile(join(root, 'packages/a/b/src/types.d.ts'), 'export interface Value { count: number }\n')
    const printed: string[] = []
    expect(await runDebtMeasure({ root, environment: { npm_execpath: 'bun' }, out: (text) => { printed.push(text) } })).toBe(0)
    expect(printed.join('')).toBe('coverage-debt measure: 2 source file(s): 2 at 100%, 0 short, 0 unmeasured\n')
  })

  it('fails a failing test even when its source coverage is complete', async () => {
    const root = await repository('export const value = () => 7\n', 'expect(value()).toBe(8)')
    const printed: string[] = []
    expect(await runDebtMeasure({ root, environment: { npm_execpath: 'bun' }, out: (text) => { printed.push(text) } })).toBe(1)
    expect(printed.join('')).toBe('coverage-debt measure: 1 source file(s): 1 at 100%, 0 short, 0 unmeasured\n')
  })

  it('removes stale totals before a process fails to launch', async () => {
    const root = await repository('export const value = () => 7\n', 'expect(value()).toBe(7)')
    await mkdir(join(root, DEBT_REPORTS_DIRECTORY), { recursive: true })
    await writeFile(join(root, DEBT_REPORTS_DIRECTORY, 'file-totals.tsv'), complete)
    await expect(runDebtMeasure({ root, environment: { npm_execpath: join(root, 'missing-bun') } })).rejects.toThrow('file-totals.tsv')
  })
})
