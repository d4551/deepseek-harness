/**
 * Declaration of `coverage-file-totals.cjs`, the CommonJS istanbul reporter
 * that writes per-file `covered/total` counts as tab-separated lines. The
 * shapes below are the istanbul-lib-coverage and istanbul-lib-report fields
 * the reporter reads, declared structurally because neither library ships
 * types.
 */

declare class FileTotalsReport {
  constructor(opts?: { projectRoot?: string })
  /** Root every written path is made relative to. */
  projectRoot: string
  /** The totals file, open between `onStart` and `onEnd`. */
  out: FileTotalsReport.CoverageContentWriter | null
  onStart(root: object | undefined, context: FileTotalsReport.CoverageReportContext): undefined
  onDetail(node: FileTotalsReport.CoverageDetailNode, context: FileTotalsReport.CoverageReportContext): undefined
  onEnd(root: object | undefined, context: FileTotalsReport.CoverageReportContext): undefined
  /** File name written inside the coverage reports directory. */
  static readonly TOTALS_FILE: string
}

declare namespace FileTotalsReport {
  /** One summary metric as istanbul's `toSummary()` reports it. */
  export interface CoverageMetric {
    covered: number
    total: number
  }

  /** The per-file summary fields the reporter writes. */
  export interface CoverageSummary {
    statements: CoverageMetric
    branches: CoverageMetric
    functions: CoverageMetric
    lines: CoverageMetric
  }

  /** The per-file coverage record fields the reporter reads. */
  export interface SummarizedFileCoverage {
    path: string
    toSummary(): CoverageSummary
  }

  /** The istanbul tree node handed to `onDetail`. */
  export interface CoverageDetailNode {
    getFileCoverage(): SummarizedFileCoverage
  }

  /** The content writer istanbul's file writer hands out for a relative file name. */
  export interface CoverageContentWriter {
    println(text: string): undefined
    close(): undefined
  }

  /** The istanbul report context fields the reporter uses. */
  export interface CoverageReportContext {
    writer: { writeFile(file: string): CoverageContentWriter }
  }
}

export = FileTotalsReport
