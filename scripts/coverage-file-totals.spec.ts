/**
 * The file-totals reporter is the measurement's only source of numbers, so a
 * swapped column or a path written relative to the wrong root would misplace
 * every debt file. These specs run istanbul's visitor protocol over the
 * summary shape its file coverage produces.
 */
import { describe, expect, it } from 'vitest'
import FileTotalsReport from './coverage-file-totals.cjs'

type Summary = FileTotalsReport.CoverageSummary
type Writer = FileTotalsReport.CoverageContentWriter

/** A recording stand-in for istanbul's file writer: the requested file names, the writers, and the written lines. */
interface Sink {
  context: FileTotalsReport.CoverageReportContext
  lines: string[]
  requested: string[]
  writers: Writer[]
  closed: number
}

function recordingSink(): Sink {
  const sink: Sink = {
    lines: [],
    requested: [],
    writers: [],
    closed: 0,
    context: {
      writer: {
        writeFile(file) {
          sink.requested.push(file)
          const writer: Writer = {
            println: (text) => {
              sink.lines.push(text)
              return undefined
            },
            close: () => {
              sink.closed += 1
              return undefined
            },
          }
          sink.writers.push(writer)
          return writer
        },
      },
    },
  }
  return sink
}

function summary(statements: number[], branches: number[], functions: number[], lines: number[]): Summary {
  const metric = ([covered, total]: number[]): FileTotalsReport.CoverageMetric => ({ covered: covered ?? 0, total: total ?? 0 })
  return { statements: metric(statements), branches: metric(branches), functions: metric(functions), lines: metric(lines) }
}

function report(files: readonly { path: string; summary: Summary }[], projectRoot = '/repo'): Sink {
  const reporter = new FileTotalsReport({ projectRoot })
  const sink = recordingSink()
  reporter.onStart(undefined, sink.context)
  for (const file of files) {
    reporter.onDetail({ getFileCoverage: () => ({ path: file.path, toSummary: () => file.summary }) }, sink.context)
  }
  reporter.onEnd(undefined, sink.context)
  return sink
}

describe('the file-totals report', () => {
  it('writes one tab-separated line per file, relative to the project root, in metric order', () => {
    const sink = report([
      { path: '/repo/packages/x/y/src/a.ts', summary: summary([3, 4], [1, 2], [5, 5], [7, 9]) },
      { path: '/repo/packages/x/y/src/b.ts', summary: summary([0, 0], [0, 0], [0, 0], [0, 0]) },
    ])
    expect(sink).toMatchObject({
      requested: [FileTotalsReport.TOTALS_FILE],
      lines: [
        'packages/x/y/src/a.ts\t3/4\t1/2\t5/5\t7/9',
        'packages/x/y/src/b.ts\t0/0\t0/0\t0/0\t0/0',
      ],
      closed: 1,
    })
  })

  it('opens the totals file even when no file was measured, so a consumer finds an empty record', () => {
    expect(report([])).toMatchObject({ requested: ['file-totals.tsv'], lines: [], closed: 1 })
  })

  it('holds the writer it opened and releases it once the report ends', () => {
    const reporter = new FileTotalsReport({ projectRoot: '/repo' })
    const sink = recordingSink()
    reporter.onStart(undefined, sink.context)
    expect(reporter.out).toBe(sink.writers[0])
    reporter.onEnd(undefined, sink.context)
    expect(reporter).toMatchObject({ out: null })
    expect(sink.closed).toBe(1)
  })

  it('defaults the project root to the working directory', () => {
    expect(new FileTotalsReport().projectRoot).toBe(process.cwd())
  })
})
