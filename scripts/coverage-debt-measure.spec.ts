import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { DebtFile } from './coverage-debt.ts'
import {
  DEBT_REPORTS_DIRECTORY,
  measureCommand,
  measureDebt,
  parseFileTotals,
  renderDebtMeasure,
  runDebtMeasure,
  uncoveredCount,
} from './coverage-debt-measure.ts'
import type { FileTotals } from './coverage-debt-measure.ts'
import { STRUCTURAL_EXCLUSIONS } from './coverage-debt.ts'
import { COVERAGE_PARTITION_MODE_ENV, COVERAGE_PARTITIONS_ENV } from './coverage-partitions.ts'
import type { CoverageCommand, CoverageCommandResult } from './coverage-partitions.ts'
import { CONDITIONAL_COVERAGE_SOURCES } from './vitest-inventory.ts'

function totals(file: string, statements: string, branches: string, functions: string, lines: string): FileTotals {
  const ratio = (text: string): { covered: number; total: number } => {
    const [covered, total] = text.split('/')
    return { covered: Number(covered), total: Number(total) }
  }
  return { file, statements: ratio(statements), branches: ratio(branches), functions: ratio(functions), lines: ratio(lines) }
}

function debt(file: string, marker: string, ...globs: string[]): DebtFile {
  return { file, marker, globs }
}

describe('parseFileTotals', () => {
  it('reads one record per line and ignores the trailing newline', () => {
    const parsed = parseFileTotals('packages/a/b/src/x.ts\t3/4\t1/2\t5/5\t7/9\npackages/a/b/src/y.ts\t0/0\t0/0\t0/0\t0/0\n')
    expect([...parsed.values()]).toEqual([
      totals('packages/a/b/src/x.ts', '3/4', '1/2', '5/5', '7/9'),
      totals('packages/a/b/src/y.ts', '0/0', '0/0', '0/0', '0/0'),
    ])
  })

  it.each([
    ['packages/a/b/src/x.ts\t3/4\t1/2\t5/5', /expected a path and four ratios/],
    ['packages/a/b/src/x.ts\t3/4\t1/2\t5/5\t7/9\textra', /expected a path and four ratios/],
    ['\t3/4\t1/2\t5/5\t7/9', /expected a path and four ratios/],
    ['packages/a/b/src/x.ts\t3/4\t1/2\t5/5\t7 of 9', /unreadable ratio "7 of 9"/],
    ['packages/a/b/src/x.ts\t5/4\t1/2\t5/5\t7/9', /5 covered of 4/],
  ])('rejects a malformed line %j', (line, message) => {
    expect(() => parseFileTotals(`${line}\n`)).toThrow(message)
  })

  it('rejects a file reported twice', () => {
    const line = 'packages/a/b/src/x.ts\t3/4\t1/2\t5/5\t7/9\n'
    expect(() => parseFileTotals(line + line)).toThrow(/appears twice/)
  })
})

describe('uncoveredCount', () => {
  it('adds the shortfall of every metric, so an empty metric counts as met', () => {
    expect(uncoveredCount(totals('x', '3/4', '1/2', '5/5', '7/9'))).toBe(4)
    expect(uncoveredCount(totals('x', '0/0', '0/0', '0/0', '0/0'))).toBe(0)
  })
})

describe('measureDebt', () => {
  const files = [
    debt('packages/a/b/src/far.ts', 'DEBT(gui)', 'packages/a/b/src/*'),
    debt('packages/a/b/src/near.ts', 'DEBT(gui)', 'packages/a/b/src/*', 'packages/a/b/src/near.ts'),
    debt('packages/c/d/src/done.ts', 'DEBT(inspector)', 'packages/c/d/src/done.ts'),
    debt('packages/c/d/src/quiet.ts', 'DEBT(inspector)', 'packages/c/d/src/quiet.ts'),
  ]
  const measured = new Map([
    ['packages/a/b/src/far.ts', totals('packages/a/b/src/far.ts', '1/9', '0/4', '0/2', '1/9')],
    ['packages/a/b/src/near.ts', totals('packages/a/b/src/near.ts', '9/9', '3/4', '2/2', '9/9')],
    ['packages/c/d/src/done.ts', totals('packages/c/d/src/done.ts', '4/4', '0/0', '1/1', '4/4')],
    ['packages/x/y/src/other.ts', totals('packages/x/y/src/other.ts', '0/4', '0/0', '0/1', '0/4')],
  ])

  it('sorts the shortfall closest first, names the entries ready to delete, and lists what nothing loaded', () => {
    const measure = measureDebt(files, measured)
    expect(measure).toEqual({
      met: ['packages/c/d/src/done.ts'],
      // `packages/a/b/src/*` still hides far.ts, so only done.ts's own entry is ready.
      ready: ['packages/c/d/src/done.ts'],
      open: [
        { ...files[1], totals: measured.get('packages/a/b/src/near.ts') },
        { ...files[0], totals: measured.get('packages/a/b/src/far.ts') },
      ],
      unmeasured: [files[3]],
    })
  })

  it('marks an entry ready only once every file it names meets the bar', () => {
    const both = new Map(measured)
    both.set('packages/a/b/src/far.ts', totals('packages/a/b/src/far.ts', '9/9', '4/4', '2/2', '9/9'))
    both.set('packages/a/b/src/near.ts', totals('packages/a/b/src/near.ts', '9/9', '4/4', '2/2', '9/9'))
    expect(measureDebt(files, both).ready).toEqual([
      'packages/a/b/src/*',
      'packages/a/b/src/near.ts',
      'packages/c/d/src/done.ts',
    ])
  })
})

describe('renderDebtMeasure', () => {
  it('prints the summary, then the ready entries, the shortfall, and the unmeasured files', () => {
    const text = renderDebtMeasure({
      met: ['packages/c/d/src/done.ts'],
      ready: ['packages/c/d/src/done.ts'],
      open: [{ ...debt('packages/a/b/src/near.ts', 'DEBT(gui)', 'packages/a/b/src/*'), totals: totals('packages/a/b/src/near.ts', '9/9', '3/4', '2/2', '9/9') }],
      unmeasured: [debt('packages/c/d/src/quiet.ts', 'DEBT(inspector)', 'packages/c/d/src/quiet.ts')],
    })
    expect(text).toBe([
      'coverage-debt measure: 3 debt file(s): 1 at the bar, 1 short, 1 unmeasured',
      'entries ready to delete (every file they name meets the bar):',
      '  packages/c/d/src/done.ts',
      'short of the bar, closest first (uncovered statements/branches/functions/lines):',
      '  packages/a/b/src/near.ts  0/1/0/0  DEBT(gui) via packages/a/b/src/*',
      'unmeasured (no suite in this run loaded the file):',
      '  packages/c/d/src/quiet.ts  DEBT(inspector) via packages/c/d/src/quiet.ts',
      '',
    ].join('\n'))
  })

  it('prints only the summary when nothing is ready, short, or unmeasured', () => {
    expect(renderDebtMeasure({ met: ['a'], ready: [], open: [], unmeasured: [] }))
      .toBe('coverage-debt measure: 1 debt file(s): 1 at the bar, 0 short, 0 unmeasured\n')
  })
})

describe('measureCommand', () => {
  it('runs the gate lane with zeroed thresholds, the totals reporter, and only the non-debt exclusions', () => {
    const command = measureCommand('/repo', ['packages/a/b/tests'], { npm_execpath: '/tools/bun' })
    expect(command.command).toBe('/tools/bun')
    expect(command.args.slice(0, 5)).toEqual(['x', 'vitest', 'run', '--coverage', '--coverage.reportOnFailure'])
    expect(command.args).toEqual(expect.arrayContaining([
      `--coverage.reportsDirectory=${DEBT_REPORTS_DIRECTORY}`,
      '--coverage.thresholds.perFile=false',
      '--coverage.thresholds.statements=0',
      '--coverage.thresholds.branches=0',
      '--coverage.thresholds.functions=0',
      '--coverage.thresholds.lines=0',
      ...[...STRUCTURAL_EXCLUSIONS, ...CONDITIONAL_COVERAGE_SOURCES].map(glob => `--coverage.exclude=${glob}`),
    ]))
    const reporter = command.args.find(arg => arg.startsWith('--coverage.reporter='))
    expect(reporter).toMatch(/--coverage\.reporter=.*coverage-file-totals\.cjs$/)
    expect(command.args.at(-1)).toBe('packages/a/b/tests')
    expect(command).toMatchObject({
      label: 'coverage debt measurement',
      cwd: '/repo',
      env: { [COVERAGE_PARTITIONS_ENV]: undefined, [COVERAGE_PARTITION_MODE_ENV]: undefined },
    })
  })
})

describe('runDebtMeasure', () => {
  async function repository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coverage-debt-measure-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'packages/a/b/src'), { recursive: true })
    await writeFile(join(root, 'packages/a/b/src/x.ts'), 'export const x = 1\n')
    await writeFile(join(root, 'packages/a/b/src/y.ts'), 'export const y = 2\n')
    await writeFile(join(root, 'vitest.config.ts'), [
      'export default { test: { coverage: {',
      '      exclude: [',
      "        'packages/*/*/src/types.ts',",
      '        // DEBT(gui): the whole package.',
      "        'packages/a/b/src/*',",
      '      ],',
      '    } } }',
      '',
    ].join('\n'))
    return root
  }

  function runner(root: string, tsv: string, result: CoverageCommandResult) {
    const commands: CoverageCommand[] = []
    const run = async (command: CoverageCommand): Promise<CoverageCommandResult> => {
      commands.push(command)
      await mkdir(join(root, DEBT_REPORTS_DIRECTORY), { recursive: true })
      await writeFile(join(root, DEBT_REPORTS_DIRECTORY, 'file-totals.tsv'), tsv)
      return result
    }
    return { commands, run }
  }

  it('measures the live debt files against the totals the run wrote', async () => {
    const root = await repository()
    const { commands, run } = runner(root, 'packages/a/b/src/x.ts\t4/4\t2/2\t1/1\t4/4\npackages/a/b/src/y.ts\t1/3\t0/0\t0/1\t1/3\n', {
      exitCode: 0,
      signalCode: null,
    })
    const printed: string[] = []
    const code = await runDebtMeasure({
      root,
      vitestArgs: ['packages/a/b/tests'],
      environment: { npm_execpath: '/tools/bun' },
      runCommand: run,
      out: (text) => { printed.push(text) },
    })
    expect(code).toBe(0)
    expect(commands.map(command => [command.command, command.cwd])).toEqual([['/tools/bun', root]])
    expect(commands[0]?.args.at(-1)).toBe('packages/a/b/tests')
    expect(printed.join('')).toBe([
      'coverage-debt measure: 2 debt file(s): 1 at the bar, 1 short, 0 unmeasured',
      'short of the bar, closest first (uncovered statements/branches/functions/lines):',
      '  packages/a/b/src/y.ts  2/0/1/2  DEBT(gui) via packages/a/b/src/*',
      '',
    ].join('\n'))
  })

  it('still reports the totals of a failing run, and answers non-zero for it', async () => {
    const root = await repository()
    const { run } = runner(root, 'packages/a/b/src/x.ts\t4/4\t2/2\t1/1\t4/4\npackages/a/b/src/y.ts\t3/3\t0/0\t1/1\t3/3\n', {
      exitCode: 1,
      signalCode: null,
    })
    const printed: string[] = []
    const code = await runDebtMeasure({
      root,
      environment: { npm_execpath: '/tools/bun' },
      runCommand: run,
      out: (text) => { printed.push(text) },
    })
    expect(code).toBe(1)
    expect(printed.join('')).toBe([
      'coverage-debt measure: 2 debt file(s): 2 at the bar, 0 short, 0 unmeasured',
      'entries ready to delete (every file they name meets the bar):',
      '  packages/a/b/src/*',
      '',
    ].join('\n'))
  })

  it('fails loud when the run left no totals behind', async () => {
    const root = await repository()
    const run = async (): Promise<CoverageCommandResult> => ({ exitCode: null, signalCode: null, error: 'spawn ENOENT' })
    await expect(runDebtMeasure({ root, environment: { npm_execpath: '/tools/bun' }, runCommand: run, out: () => undefined }))
      .rejects.toThrow(/file-totals\.tsv/)
  })
})
