/**
 * Measure the coverage debt against the bar it waits behind.
 *
 * `verify-coverage-debt` counts the exclusions; this runs the instrumented
 * lane with the debt entries lifted and reports every debt file's distance
 * from per-file 100%, so the ratchet moves on measurement: an entry whose
 * files already meet the bar is named as ready to delete, and the rest are
 * listed closest first. The structural and platform-conditional exclusions
 * stay in force — they are not debt — and a host-conditional one is dropped
 * on every host because it never enters the inventory on any.
 *
 * `bun run measure-coverage-debt [-- <vitest args>]`: trailing arguments
 * narrow the run (`-- packages/client/ui-commands/tests` measures what that
 * package's own suites cover). A full run costs what the coverage lane costs;
 * `DSH_COVERAGE_EXEMPT_HEAVY=1` drops the heavy suites the way the gate does.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bunInvocation } from './bun-invocation.ts'
import { STRUCTURAL_EXCLUSIONS, coverageExclusions, debtFiles, vitestConfigSource } from './coverage-debt.ts'
import type { DebtFile } from './coverage-debt.ts'
import FileTotalsReport from './coverage-file-totals.cjs'
import {
  COVERAGE_PARTITION_MODE_ENV,
  COVERAGE_PARTITIONS_ENV,
  forwardedCoverageArgs,
  runCoverageCommand,
} from './coverage-partitions.ts'
import type { CoverageCommand, CoverageCommandRunner } from './coverage-partitions.ts'
import { CONDITIONAL_COVERAGE_SOURCES } from './vitest-inventory.ts'

/** `covered/total` of one metric. */
export interface CoverageRatio {
  covered: number
  total: number
}

/** One measured file's counts, as the file-totals reporter wrote them. */
export interface FileTotals {
  /** Repository-relative path. */
  file: string
  statements: CoverageRatio
  branches: CoverageRatio
  functions: CoverageRatio
  lines: CoverageRatio
}

/** One debt file beside its measurement. */
export interface MeasuredDebtFile extends DebtFile {
  totals: FileTotals
}

/** The measurement: what to delete, what is still short, what nothing loaded. */
export interface DebtMeasure {
  /** Debt files that meet the bar, sorted by path. */
  met: string[]
  /** Debt globs every file of which meets the bar, sorted. */
  ready: string[]
  /** Debt files still short of the bar, fewest uncovered items first. */
  open: MeasuredDebtFile[]
  /** Debt files the run never loaded, so nothing measured them. */
  unmeasured: DebtFile[]
}

/** Construction inputs for {@link runDebtMeasure}. */
export interface DebtMeasureOptions {
  /** Repository root that owns `vitest.config.ts` and the coverage output. */
  root: string
  /** Arguments forwarded to Vitest after the measurement's own. */
  vitestArgs?: readonly string[]
  /** Lifecycle environment naming bun in `npm_execpath`; the process environment when absent. */
  environment?: NodeJS.ProcessEnv
  /** Child executor, injectable for scheduler tests. */
  runCommand?: CoverageCommandRunner
  /** Report sink, injectable for rendering tests. */
  out?: (text: string) => void
}

/** Reports directory the measurement writes, inside the gitignored coverage tree. */
export const DEBT_REPORTS_DIRECTORY = 'coverage/.debt'

const RATIO = /^(\d+)\/(\d+)$/

function parseRatio(text: string, line: string): CoverageRatio {
  const match = RATIO.exec(text)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`file-totals: unreadable ratio ${JSON.stringify(text)} in ${JSON.stringify(line)}.`)
  }
  const covered = Number.parseInt(match[1], 10)
  const total = Number.parseInt(match[2], 10)
  if (covered > total) throw new Error(`file-totals: ${covered} covered of ${total} in ${JSON.stringify(line)}.`)
  return { covered, total }
}

/**
 * Read the totals file back: one record per measured file.
 * @param text - the reporter's tab-separated output.
 * @returns totals keyed by repository-relative path.
 */
export function parseFileTotals(text: string): Map<string, FileTotals> {
  const totals = new Map<string, FileTotals>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const fields = line.split('\t')
    const [file, statements, branches, functions, lines] = fields
    if (
      fields.length !== 5
      || file === undefined || file === ''
      || statements === undefined || branches === undefined || functions === undefined || lines === undefined
    ) {
      throw new Error(`file-totals: expected a path and four ratios, got ${JSON.stringify(line)}.`)
    }
    if (totals.has(file)) throw new Error(`file-totals: ${file} appears twice.`)
    totals.set(file, {
      file,
      statements: parseRatio(statements, line),
      branches: parseRatio(branches, line),
      functions: parseRatio(functions, line),
      lines: parseRatio(lines, line),
    })
  }
  return totals
}

/**
 * Items the four metrics still leave uncovered; zero means the file meets
 * per-file 100%, an empty metric counting as met the way istanbul scores it.
 * @param totals - one file's counts.
 * @returns uncovered statements, branches, functions, and lines added together.
 */
export function uncoveredCount(totals: FileTotals): number {
  return [totals.statements, totals.branches, totals.functions, totals.lines]
    .reduce((sum, ratio) => sum + (ratio.total - ratio.covered), 0)
}

/**
 * Place every debt file against the bar.
 * @param files - the debt files, as `coverage-debt.ts` lists them.
 * @param totals - the measured totals.
 * @returns the measurement.
 */
export function measureDebt(files: readonly DebtFile[], totals: ReadonlyMap<string, FileTotals>): DebtMeasure {
  const met: string[] = []
  const open: MeasuredDebtFile[] = []
  const unmeasured: DebtFile[] = []
  const byGlob = new Map<string, string[]>()
  for (const file of files) {
    for (const glob of file.globs) {
      const names = byGlob.get(glob)
      if (names === undefined) byGlob.set(glob, [file.file])
      else names.push(file.file)
    }
    const measured = totals.get(file.file)
    if (measured === undefined) {
      unmeasured.push(file)
    } else if (uncoveredCount(measured) === 0) {
      met.push(file.file)
    } else {
      open.push({ ...file, totals: measured })
    }
  }
  const metSet = new Set(met)
  open.sort((a, b) => uncoveredCount(a.totals) - uncoveredCount(b.totals) || a.file.localeCompare(b.file))
  const ready = [...byGlob]
    .filter(([, names]) => names.every(name => metSet.has(name)))
    .map(([glob]) => glob)
    .sort()
  return { met: met.sort(), ready, open, unmeasured }
}

function shortfall(totals: FileTotals): string {
  return [totals.statements, totals.branches, totals.functions, totals.lines]
    .map(ratio => String(ratio.total - ratio.covered))
    .join('/')
}

/**
 * Render the measurement for the terminal.
 * @param measure - the measurement.
 * @returns the report text, newline-terminated.
 */
export function renderDebtMeasure(measure: DebtMeasure): string {
  const total = measure.met.length + measure.open.length + measure.unmeasured.length
  const lines = [
    `coverage-debt measure: ${total} debt file(s): ${measure.met.length} at the bar, `
    + `${measure.open.length} short, ${measure.unmeasured.length} unmeasured`,
  ]
  if (measure.ready.length > 0) {
    lines.push('entries ready to delete (every file they name meets the bar):')
    for (const glob of measure.ready) lines.push(`  ${glob}`)
  }
  if (measure.open.length > 0) {
    lines.push('short of the bar, closest first (uncovered statements/branches/functions/lines):')
    for (const file of measure.open) {
      lines.push(`  ${file.file}  ${shortfall(file.totals)}  ${file.marker} via ${file.globs.join(', ')}`)
    }
  }
  if (measure.unmeasured.length > 0) {
    lines.push('unmeasured (no suite in this run loaded the file):')
    for (const file of measure.unmeasured) lines.push(`  ${file.file}  ${file.marker} via ${file.globs.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * The Vitest invocation that measures the debt: the gate's own lane with the
 * thresholds lowered to zero, the file-totals reporter, and only the
 * structural and platform-conditional exclusions in force.
 * @param root - repository root.
 * @param vitestArgs - arguments forwarded after the measurement's own.
 * @param environment - lifecycle environment naming bun; the process environment when absent.
 * @returns the command the coordinator runs.
 */
export function measureCommand(root: string, vitestArgs: readonly string[], environment?: NodeJS.ProcessEnv): CoverageCommand {
  const reporter = fileURLToPath(new URL('./coverage-file-totals.cjs', import.meta.url))
  const invocation = bunInvocation([
    'x',
    'vitest',
    'run',
    '--coverage',
    '--coverage.reportOnFailure',
    `--coverage.reporter=${reporter}`,
    `--coverage.reportsDirectory=${DEBT_REPORTS_DIRECTORY}`,
    '--coverage.thresholds.perFile=false',
    '--coverage.thresholds.statements=0',
    '--coverage.thresholds.branches=0',
    '--coverage.thresholds.functions=0',
    '--coverage.thresholds.lines=0',
    ...[...STRUCTURAL_EXCLUSIONS, ...CONDITIONAL_COVERAGE_SOURCES].map(glob => `--coverage.exclude=${glob}`),
    ...vitestArgs,
  ], environment)
  return {
    label: 'coverage debt measurement',
    ...invocation,
    env: {
      [COVERAGE_PARTITIONS_ENV]: undefined,
      [COVERAGE_PARTITION_MODE_ENV]: undefined,
    },
    cwd: root,
  }
}

/**
 * Run the measurement and print the report.
 * @param options - root, forwarded arguments, and injectable seams.
 * @returns zero when the Vitest run succeeded; the report prints either way once totals exist.
 */
export async function runDebtMeasure(options: DebtMeasureOptions): Promise<number> {
  const runCommand = options.runCommand ?? runCoverageCommand
  const out = options.out ?? ((text: string) => { process.stdout.write(text) })
  const files = debtFiles(coverageExclusions(vitestConfigSource(options.root)), options.root)
  const result = await runCommand(measureCommand(options.root, options.vitestArgs ?? [], options.environment))
  const totals = await readFile(join(options.root, DEBT_REPORTS_DIRECTORY, FileTotalsReport.TOTALS_FILE), 'utf8')
  out(renderDebtMeasure(measureDebt(files, parseFileTotals(totals))))
  return result.exitCode === 0 && result.signalCode === null && result.error === undefined ? 0 : 1
}

if (import.meta.main) {
  process.exitCode = await runDebtMeasure({
    root: resolve(import.meta.dirname, '..'),
    vitestArgs: forwardedCoverageArgs(process.argv.slice(2)),
  })
}
