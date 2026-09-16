/** Measure every package source against the configured per-file coverage thresholds. */
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bunInvocation } from './bun-invocation.ts'
import { coveragePolicyProblems, coverageSourceFiles, vitestConfigSource } from './coverage-debt.ts'
import FileTotalsReport from './coverage-file-totals.cjs'
import { forwardedCoverageArgs, runCoverageCommand } from './coverage-command.ts'
import type { CoverageCommand } from './coverage-command.ts'

/** Counts for one coverage metric. */
export interface CoverageRatio {
  covered: number
  total: number
}

/** Counts emitted by the coverage reporter for one repository-relative file. */
export interface FileTotals {
  file: string
  statements: CoverageRatio
  branches: CoverageRatio
  functions: CoverageRatio
  lines: CoverageRatio
}

/** Complete source inventory classified by measured coverage. */
export interface DebtMeasure {
  met: string[]
  open: FileTotals[]
  unmeasured: string[]
}

/** Inputs for a coverage measurement using the real Vitest process. */
export interface DebtMeasureOptions {
  root: string
  vitestArgs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  out?: (text: string) => void
}

/** Coverage output directory, relative to the repository root. */
export const DEBT_REPORTS_DIRECTORY = 'coverage/.debt'

function parseRatio(text: string, line: string): CoverageRatio {
  const match = /^(\d+)\/(\d+)$/.exec(text)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`file-totals: unreadable ratio ${JSON.stringify(text)} in ${JSON.stringify(line)}.`)
  }
  const covered = Number.parseInt(match[1], 10)
  const total = Number.parseInt(match[2], 10)
  if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(total) || covered > total) {
    throw new Error(`file-totals: invalid counts ${covered}/${total} in ${JSON.stringify(line)}.`)
  }
  return { covered, total }
}

/**
 * Parse the reporter's tab-separated counts, rejecting duplicate files and malformed counts.
 * @param text - Complete reporter output.
 * @returns Counts keyed by normalized repository-relative path.
 */
export function parseFileTotals(text: string): Map<string, FileTotals> {
  const totals = new Map<string, FileTotals>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    const fields = line.split('\t')
    const [rawFile, statements, branches, functions, lines] = fields
    if (fields.length !== 5 || rawFile === undefined || rawFile === ''
      || statements === undefined || branches === undefined || functions === undefined || lines === undefined) {
      throw new Error(`file-totals: expected a path and four ratios, got ${JSON.stringify(line)}.`)
    }
    const file = rawFile.split('\\').join('/')
    if (file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').some(part => part === '..' || part === '.' || part === '')) {
      throw new Error(`file-totals: expected a repository-relative path, got ${JSON.stringify(file)}.`)
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
 * Count uncovered statements, branches, functions and lines.
 * @param totals - Measured counts for one source file.
 * @returns Combined shortfall; an empty metric contributes zero.
 */
export function uncoveredCount(totals: FileTotals): number {
  return [totals.statements, totals.branches, totals.functions, totals.lines]
    .reduce((sum, ratio) => sum + (ratio.total - ratio.covered), 0)
}

/**
 * Classify every source file, including files absent from the report.
 * @param files - Canonical source inventory.
 * @param totals - Measured counts.
 * @returns Complete measurement; an empty or repeated source inventory throws.
 */
export function measureDebt(files: readonly string[], totals: ReadonlyMap<string, FileTotals>): DebtMeasure {
  if (files.length === 0 || new Set(files).size !== files.length) {
    throw new Error('coverage-debt: source inventory must be nonempty and unique')
  }
  const met: string[] = []
  const open: FileTotals[] = []
  const unmeasured: string[] = []
  for (const file of files) {
    const measured = totals.get(file)
    if (measured === undefined) unmeasured.push(file)
    else if (uncoveredCount(measured) === 0) met.push(file)
    else open.push(measured)
  }
  open.sort((a, b) => uncoveredCount(a) - uncoveredCount(b) || a.file.localeCompare(b.file))
  return { met: met.sort(), open, unmeasured: unmeasured.sort() }
}

/**
 * Render coverage shortfalls and absent measurements.
 * @param measure - Complete measurement.
 * @returns Newline-terminated report.
 */
export function renderDebtMeasure(measure: DebtMeasure): string {
  const total = measure.met.length + measure.open.length + measure.unmeasured.length
  const lines = [
    `coverage-debt measure: ${total} source file(s): ${measure.met.length} at 100%, `
    + `${measure.open.length} short, ${measure.unmeasured.length} unmeasured`,
  ]
  if (measure.open.length > 0) {
    lines.push('below 100% (uncovered statements/branches/functions/lines):')
    for (const totals of measure.open) {
      const shortfall = [totals.statements, totals.branches, totals.functions, totals.lines]
        .map(ratio => String(ratio.total - ratio.covered)).join('/')
      lines.push(`  ${totals.file}  ${shortfall}`)
    }
  }
  if (measure.unmeasured.length > 0) {
    lines.push('unmeasured source files (coverage verification failed):')
    for (const file of measure.unmeasured) lines.push(`  ${file}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Build a coverage run without overriding policy or accepting option overrides.
 * @param root - Repository root.
 * @param vitestArgs - Optional positional test paths; option arguments throw.
 * @param environment - Bun lifecycle environment.
 * @returns Shell-free command using the configured coverage policy.
 */
export function measureCommand(root: string, vitestArgs: readonly string[], environment?: NodeJS.ProcessEnv): CoverageCommand {
  for (const arg of vitestArgs) {
    if (arg.startsWith('-') || arg === '') throw new Error('coverage-debt: only positional test paths may be forwarded')
  }
  const reporter = fileURLToPath(new URL('./coverage-file-totals.cjs', import.meta.url))
  const invocation = bunInvocation([
    'x', 'vitest', 'run', '--coverage.enabled', '--coverage.reportOnFailure',
    `--coverage.reporter=${reporter}`,
    `--coverage.reportsDirectory=${DEBT_REPORTS_DIRECTORY}`,
    ...vitestArgs,
  ], environment)
  return {
    label: 'coverage debt measurement',
    ...invocation,
    env: {},
    cwd: root,
  }
}

/**
 * Run coverage and require a successful process plus complete per-file measurements.
 * Stale totals are removed before execution. Missing output and invalid configuration throw.
 * @param options - Root, optional test paths and report sink.
 * @returns Zero only when every canonical file has all four metrics at 100%.
 */
export async function runDebtMeasure(options: DebtMeasureOptions): Promise<number> {
  const problems = coveragePolicyProblems(vitestConfigSource(options.root))
  if (problems.length > 0) throw new Error(problems.join('\n'))
  const files = coverageSourceFiles(options.root)
  const command = measureCommand(options.root, options.vitestArgs ?? [], options.environment)
  const totalsPath = join(options.root, DEBT_REPORTS_DIRECTORY, FileTotalsReport.TOTALS_FILE)
  await rm(totalsPath, { force: true })
  const result = await runCoverageCommand(command)
  const totals = await readFile(totalsPath, 'utf8')
  const measure = measureDebt(files, parseFileTotals(totals))
  const out = options.out ?? ((text: string) => { process.stdout.write(text) })
  out(renderDebtMeasure(measure))
  return result.exitCode === 0 && result.signalCode === null && result.error === undefined
    && measure.open.length === 0 && measure.unmeasured.length === 0 ? 0 : 1
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  process.exitCode = await runDebtMeasure({
    root: resolve(import.meta.dirname, '..'),
    vitestArgs: forwardedCoverageArgs(process.argv.slice(2)),
  })
}
