/**
 * The uncovered-locations reporter is what turns a per-file threshold ERROR
 * into clickable `path:line:col` records. Nothing drove it before, so a record
 * pointing at the wrong column, a dropped implicit branch arm, or a header
 * printed for a green tree would have degraded silently. These specs run
 * istanbul's visitor protocol — onStart, onDetail per file, onEnd — over the
 * record shapes v8 remapping produces.
 */
import { describe, expect, it } from 'vitest'
import UncoveredLocationsReport from './coverage-uncovered-locations.cjs'

type FileCoverage = UncoveredLocationsReport.UncoveredFileCoverage
type Location = UncoveredLocationsReport.CoverageLocation

function span(line: number, column: number, endLine = line, endColumn = column): Location {
  return { start: { line, column }, end: { line: endLine, column: endColumn } }
}

function fileCoverage(path: string, over: Partial<FileCoverage> = {}): FileCoverage {
  return { path, statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {}, ...over }
}

/** A recording stand-in for istanbul's console writer: every requested file and printed line. */
interface Sink {
  context: UncoveredLocationsReport.CoverageReportContext
  lines: string[]
  requested: (string | null)[]
  closed: number
}

function recordingSink(): Sink {
  const sink: Sink = {
    lines: [],
    requested: [],
    closed: 0,
    context: {
      writer: {
        writeFile(file) {
          sink.requested.push(file)
          return {
            println: (text) => {
              sink.lines.push(text)
              return undefined
            },
            close: () => {
              sink.closed += 1
              return undefined
            },
          }
        },
      },
    },
  }
  return sink
}

function report(files: readonly FileCoverage[], projectRoot = '/repo'): Sink {
  const reporter = new UncoveredLocationsReport({ projectRoot })
  const sink = recordingSink()
  reporter.onStart(undefined, sink.context)
  for (const fc of files) reporter.onDetail({ getFileCoverage: () => fc }, sink.context)
  reporter.onEnd(undefined, sink.context)
  return sink
}

describe('the uncovered-locations report', () => {
  it('prints nothing for a fully covered tree, never opening the console', () => {
    const covered = fileCoverage('/repo/src/a.ts', {
      statementMap: { 0: span(1, 0, 1, 10) },
      s: { 0: 3 },
      fnMap: { 0: { name: 'f', decl: span(1, 0), loc: span(1, 0, 3, 1) } },
      f: { 0: 1 },
      branchMap: { 0: { type: 'if', loc: span(2, 2), locations: [span(2, 2), span(2, 2)] } },
      b: { 0: [1, 2] },
    })
    expect(report([covered])).toMatchObject({ lines: [], requested: [], closed: 0 })
  })

  it('names every uncovered statement, function, and branch path at its editor position', () => {
    const fc = fileCoverage('/repo/packages/x/y/src/a.ts', {
      statementMap: { 0: span(5, 4, 5, 20), 1: span(9, 0, 9, 3) },
      s: { 0: 0, 1: 1 },
      fnMap: { 0: { name: 'run', decl: span(3, 16), loc: span(3, 16, 7, 1) } },
      f: { 0: 0 },
      branchMap: { 0: { type: 'if', loc: span(4, 2), locations: [span(4, 2), span(6, 9)] } },
      b: { 0: [2, 0] },
    })
    // Header, then records sorted by line and column, then a blank spacer;
    // istanbul columns are 0-based and the records are printed 1-based. The
    // console is istanbul's `null` file, opened once and closed once.
    expect(report([fc])).toMatchObject({
      lines: [
        '\nUncovered locations (per-file 100% gate): 3',
        'packages/x/y/src/a.ts:3:17 uncovered function run',
        'packages/x/y/src/a.ts:5:5 uncovered statement (to 5:21)',
        'packages/x/y/src/a.ts:6:10 uncovered branch (if, path 2/2)',
        '',
      ],
      requested: [null],
      closed: 1,
    })
  })

  it('orders records by position within a file and keeps files in visiting order', () => {
    const first = fileCoverage('/repo/src/a.ts', { statementMap: { 0: span(8, 0), 1: span(2, 0) }, s: { 0: 0, 1: 0 } })
    const second = fileCoverage('/repo/src/b.ts', { statementMap: { 0: span(1, 0) }, s: { 0: 0 } })
    expect(report([first, second]).lines.slice(1, -1)).toEqual([
      'src/a.ts:2:1 uncovered statement',
      'src/a.ts:8:1 uncovered statement',
      'src/b.ts:1:1 uncovered statement',
    ])
  })

  it('describes a range only when its end adds information beyond the start', () => {
    const records = UncoveredLocationsReport.uncoveredRecords(fileCoverage('/repo/src/a.ts', {
      statementMap: {
        same: span(1, 0),
        wholeLine: { start: { line: 2, column: 0 }, end: { line: 2, column: Number.POSITIVE_INFINITY } },
        wholeLines: { start: { line: 3, column: 0 }, end: { line: 5, column: Number.POSITIVE_INFINITY } },
        exact: span(6, 2, 6, 9),
        endless: { start: { line: 7, column: 1 } },
        badEnd: { start: { line: 8, column: 1 }, end: { line: Number.NaN, column: 4 } },
      },
      s: { same: 0, wholeLine: 0, wholeLines: 0, exact: 0, endless: 0, badEnd: 0 },
    }), 'src/a.ts')
    expect(records).toEqual([
      'src/a.ts:1:1 uncovered statement',
      'src/a.ts:2:1 uncovered statement',
      'src/a.ts:3:1 uncovered statement (to 5)',
      'src/a.ts:6:3 uncovered statement (to 6:10)',
      'src/a.ts:7:2 uncovered statement',
      'src/a.ts:8:2 uncovered statement',
    ])
  })

  it('falls back from an unusable declaration span to the function body, and omits an absent name', () => {
    const records = UncoveredLocationsReport.uncoveredRecords(fileCoverage('/repo/src/a.ts', {
      fnMap: {
        0: { name: 'named', decl: { start: { line: 0, column: 0 } }, loc: span(4, 6) },
        1: { decl: span(9, 2), loc: span(9, 2, 12, 1) },
      },
      f: { 0: 0, 1: 0 },
    }), 'src/a.ts')
    expect(records).toEqual([
      'src/a.ts:4:7 uncovered function named',
      'src/a.ts:9:3 uncovered function',
    ])
  })

  it('keeps an implicit branch arm clickable through the branch span', () => {
    const records = UncoveredLocationsReport.uncoveredRecords(fileCoverage('/repo/src/a.ts', {
      branchMap: {
        0: { type: 'if', loc: span(3, 4), locations: [span(3, 4), undefined] },
        1: { type: 'cond-expr', loc: span(7, 0) },
      },
      b: { 0: [1, 0], 1: [0, 0] },
    }), 'src/a.ts')
    expect(records).toEqual([
      'src/a.ts:3:5 uncovered branch (if, path 2/2)',
      'src/a.ts:7:1 uncovered branch (cond-expr, path 1/2)',
      'src/a.ts:7:1 uncovered branch (cond-expr, path 2/2)',
    ])
  })

  it('drops a record whose only location has no usable start line', () => {
    const records = UncoveredLocationsReport.uncoveredRecords(fileCoverage('/repo/src/a.ts', {
      statementMap: { 0: { start: { line: 0, column: 0 } } },
      s: { 0: 0 },
      fnMap: { 0: { name: 'f', loc: { start: { line: Number.NaN, column: 0 } } } },
      f: { 0: 0 },
      branchMap: { 0: { type: 'if', loc: { start: { line: 0, column: 0 } }, locations: [undefined] } },
      b: { 0: [0] },
    }), 'src/a.ts')
    expect(records).toEqual([])
  })

  it('starts every report from an empty record set', () => {
    const reporter = new UncoveredLocationsReport({ projectRoot: '/repo' })
    const stale = fileCoverage('/repo/src/stale.ts', { statementMap: { 0: span(1, 0) }, s: { 0: 0 } })
    const fresh = fileCoverage('/repo/src/fresh.ts', { statementMap: { 0: span(2, 0) }, s: { 0: 0 } })
    const first = recordingSink()
    reporter.onStart(undefined, first.context)
    reporter.onDetail({ getFileCoverage: () => stale }, first.context)
    reporter.onEnd(undefined, first.context)
    const second = recordingSink()
    reporter.onStart(undefined, second.context)
    reporter.onDetail({ getFileCoverage: () => fresh }, second.context)
    reporter.onEnd(undefined, second.context)
    expect(second.lines).toEqual([
      '\nUncovered locations (per-file 100% gate): 1',
      'src/fresh.ts:2:1 uncovered statement',
      '',
    ])
  })

  it('defaults the project root to the working directory', () => {
    expect(new UncoveredLocationsReport().projectRoot).toBe(process.cwd())
  })
})
