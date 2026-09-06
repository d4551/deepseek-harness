/**
 * The coverage gate's exclusion list, read as data.
 *
 * `vitest.config.ts` carries what per-file 100% does not cover. Two kinds sit
 * in that list: structural entries, where there is no runtime coverage to
 * measure or the executing composition is a Worker, browser realm, or
 * subprocess unit-process V8 cannot observe; and debt entries, waiting on a
 * lane that does not exist yet. `docs/testing.md` says the debt is marked, so
 * this reads the markers back and fails when the list stops matching that
 * claim — including when an entry names a path no longer in the tree, which
 * exempts nothing while still reading as an exemption.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/**
 * Markers that name the lane a debt entry waits on. `docs/testing.md` states
 * this list; a marker outside it, or one this list names and the config never
 * uses, means the two have drifted.
 */
export const COVERAGE_DEBT_MARKERS: readonly string[] = ['TODO(gui)', 'TODO(inspector)', 'TODO(webworker)']

/**
 * Globs that legitimately match nothing in a clean tree.
 *
 * A killed executable lint-contract test can leave a non-product source probe
 * behind; the exclusion exists so that probe cannot fail the gate, and matching
 * nothing is what it looks like when no test was killed.
 */
export const TRANSIENT_EXCLUSIONS: readonly string[] = ['packages/*/*/src/oxlint-contract-*.ts']

/**
 * Exclusions that are not debt.
 *
 * Each one either has no runtime coverage to measure, or its executing
 * composition is a Worker, browser realm, or subprocess that unit-process V8
 * cannot observe, or it imports generated Host-for-Client code that exists
 * only in `lib` and is executed by the post-build smoke. Listed by glob so a
 * new exclusion is debt by default and has to be argued into this set rather
 * than joining it by omission.
 */
export const STRUCTURAL_EXCLUSIONS: readonly string[] = [
  'packages/*/*/src/types.ts',
  'packages/*/*/src/bin.ts',
  'packages/*/*/src/worker.ts',
  'packages/*/*/src/oxlint-contract-*.ts',
  'packages/experimental/inspector/src/client/**',
  'packages/experimental/inspector/src/host/bridge/**',
  'packages/experimental/inspector/src/host/cdp/**',
  'packages/experimental/inspector/src/worker/bridge/**',
  'packages/experimental/inspector/src/worker/cdp/**',
  'packages/experimental/inspector/src/worker/realms/**',
  'packages/experimental/inspector/src/worker/{entry,server}.ts',
  'packages/api/remotes/src/index.ts',
  'packages/api/remotes/src/client/index.ts',
  'packages/client/ui-agent-team/src/client/index.ts',
  'packages/typert/generator/src/*.ts',
]

/** One entry of the coverage exclusion list. */
export interface CoverageExclusion {
  /** The glob as written. */
  glob: string
  /** The debt marker governing it, or undefined when it is structural. */
  marker: string | undefined
}

/**
 * Read the coverage exclusion list out of the Vitest config.
 *
 * An entry belongs to the nearest comment above it, so a marker governs every
 * glob down to the next comment. Spread entries (`...windowsOnlyCoverageExclusions`)
 * are platform-conditional and computed above the list, so they carry no glob
 * to read here.
 * @param source - `vitest.config.ts` text.
 * @returns one entry per glob literal, in source order.
 */
export function coverageExclusions(source: string): CoverageExclusion[] {
  const coverage = source.indexOf('coverage: {')
  if (coverage < 0) throw new Error('vitest.config.ts declares no coverage block')
  const start = source.indexOf('exclude: [', coverage)
  if (start < 0) throw new Error('vitest.config.ts coverage block declares no exclude list')
  const end = source.indexOf('\n      ],', start)
  if (end < 0) throw new Error('vitest.config.ts coverage exclude list is unterminated')
  const entries: CoverageExclusion[] = []
  let marker: string | undefined
  let afterGlob = false
  for (const line of source.slice(start, end).split('\n')) {
    const comment = /^\s*\/\/\s*(.*)$/.exec(line)
    if (comment !== null) {
      const named = COVERAGE_DEBT_MARKERS.find(candidate => comment[1]?.startsWith(candidate) === true)
      // A comment following a glob opens a new block and replaces the marker,
      // so an unmarked block cannot inherit the previous block's lane. A
      // comment following a comment continues the block it opened with.
      if (afterGlob) marker = named
      else if (named !== undefined) marker = named
      afterGlob = false
      continue
    }
    const glob = /^\s*'([^']+)',$/.exec(line)
    if (glob?.[1] !== undefined) {
      entries.push({ glob: glob[1], marker })
      afterGlob = true
      continue
    }
    // Anything else — a spread, a blank line — ends the comment's reach.
    marker = undefined
    afterGlob = false
  }
  return entries
}

/**
 * Exclusions whose glob matches no file in the tree.
 *
 * An exemption for a path that no longer exists measures nothing while still
 * reading as coverage the gate deliberately gave up, so a rename or a deletion
 * leaves the list overstating what it excuses.
 * @param entries - the exclusion list.
 * @param root - repository root.
 * @returns every glob matching nothing, minus the named transients.
 */
export function staleCoverageExclusions(
  entries: readonly CoverageExclusion[],
  root: string = ROOT,
): string[] {
  return entries
    .filter(entry => !TRANSIENT_EXCLUSIONS.includes(entry.glob))
    // Node's glob has no brace expansion, so a braced alternation is expanded
    // here before matching; an unexpanded one would read as matching nothing.
    .filter(entry => expandBraces(entry.glob).every(glob => globSync(glob, { cwd: root }).length === 0))
    .map(entry => entry.glob)
}

/**
 * Expand one level of `{a,b}` alternation in a glob.
 * @param glob - the glob as written.
 * @returns one glob per alternative, or the original when it has none.
 */
export function expandBraces(glob: string): string[] {
  const brace = /\{([^{}]*)\}/.exec(glob)
  if (brace?.[1] === undefined) return [glob]
  return brace[1].split(',').flatMap(option =>
    expandBraces(glob.slice(0, brace.index) + option + glob.slice(brace.index + brace[0].length)))
}

/**
 * Markers this file names that the config never uses.
 *
 * `docs/testing.md` states the marker list; one nothing carries describes a
 * lane the exclusion list stopped waiting on, and the doc then overstates.
 * @param entries - the exclusion list.
 * @returns every unused marker, in declaration order.
 */
export function unusedDebtMarkers(entries: readonly CoverageExclusion[]): string[] {
  const used = new Set(entries.map(entry => entry.marker).filter(marker => marker !== undefined))
  return COVERAGE_DEBT_MARKERS.filter(marker => !used.has(marker))
}

/**
 * How many exclusions each marker governs, so the debt is countable.
 * @param entries - the exclusion list.
 * @returns marker to entry count, for every marker in use.
 */
export function debtInventory(entries: readonly CoverageExclusion[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const { marker } of entries) {
    if (marker === undefined) continue
    counts[marker] = (counts[marker] ?? 0) + 1
  }
  return counts
}

/**
 * Read the live Vitest config.
 * @param root - repository root.
 * @returns `vitest.config.ts` text.
 */
export function vitestConfigSource(root: string = ROOT): string {
  return readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')
}


/**
 * Debt exclusions carrying no marker.
 *
 * Anything outside {@link STRUCTURAL_EXCLUSIONS} is waiting on a lane, and an
 * unmarked one cannot be found by the marker `docs/testing.md` tells a reader
 * to grep for.
 * @param entries - the exclusion list.
 * @returns every unmarked non-structural glob, in source order.
 */
export function unmarkedDebtExclusions(entries: readonly CoverageExclusion[]): string[] {
  return entries
    .filter(entry => entry.marker === undefined && !STRUCTURAL_EXCLUSIONS.includes(entry.glob))
    .map(entry => entry.glob)
}

/**
 * Structural declarations the config no longer excludes.
 *
 * The same staleness as {@link staleCoverageExclusions}, one level up: a glob
 * named here after the config dropped it claims a classification for an
 * exemption that is gone.
 * @param entries - the exclusion list.
 * @returns every structural glob the config does not carry, in declaration order.
 */
export function unusedStructuralExclusions(entries: readonly CoverageExclusion[]): string[] {
  const globs = new Set(entries.map(entry => entry.glob))
  return STRUCTURAL_EXCLUSIONS.filter(glob => !globs.has(glob))
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('\\').join('/'))) {
  const entries = coverageExclusions(vitestConfigSource())
  const problems = [
    ...unmarkedDebtExclusions(entries).map(glob => `${glob}: coverage debt with no ${COVERAGE_DEBT_MARKERS.join('/')} marker`),
    ...unusedStructuralExclusions(entries).map(glob => `${glob}: declared structural but the config no longer excludes it`),
    ...staleCoverageExclusions(entries).map(glob => `${glob}: excludes nothing; no file in the tree matches it`),
    ...unusedDebtMarkers(entries).map(marker => `${marker}: documented marker no exclusion carries`),
  ]
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    process.exit(1)
  }
  const inventory = debtInventory(entries)
  const counted = Object.entries(inventory).map(([marker, count]) => `${marker} ${count}`).join(', ')
  process.stdout.write(
    `coverage-debt: ${entries.length} exclusion(s), ${STRUCTURAL_EXCLUSIONS.length} structural, debt ${counted}\n`,
  )
}
