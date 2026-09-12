/**
 * Declaration of `coverage-uncovered-locations.cjs`, the CommonJS istanbul
 * reporter that istanbul-reports loads with a bare `require()`. The shapes
 * below are the istanbul-lib-coverage and istanbul-lib-report fields the
 * reporter reads, declared structurally because neither library ships types.
 */

declare class UncoveredLocationsReport {
  constructor(opts?: { projectRoot?: string })
  /** Root every printed path is made relative to. */
  projectRoot: string
  /** Records gathered since `onStart`. */
  records: string[]
  onStart(root: object | undefined, context: UncoveredLocationsReport.CoverageReportContext): undefined
  onDetail(node: UncoveredLocationsReport.CoverageDetailNode, context: UncoveredLocationsReport.CoverageReportContext): undefined
  onEnd(root: object | undefined, context: UncoveredLocationsReport.CoverageReportContext): undefined
  /** Every uncovered record of one file coverage, in source order. */
  static uncoveredRecords(fc: UncoveredLocationsReport.UncoveredFileCoverage, rel: string): string[]
}

declare namespace UncoveredLocationsReport {
  /** An istanbul source range; `end.column` is `Infinity` for v8-remapped whole-line statements. */
  export interface CoverageLocation {
    start: { line: number; column: number }
    end?: { line: number; column: number }
  }

  /** One function entry: the declaration span when istanbul has it, the body span otherwise. */
  export interface CoverageFunction {
    name?: string
    decl?: CoverageLocation
    loc: CoverageLocation
  }

  /** One branch entry; an implicit arm may carry no location of its own. */
  export interface CoverageBranch {
    type: string
    loc: CoverageLocation
    locations?: (CoverageLocation | undefined)[]
  }

  /** The per-file coverage record fields the reporter reads. */
  export interface UncoveredFileCoverage {
    path: string
    statementMap: Record<string, CoverageLocation>
    s: Record<string, number>
    fnMap: Record<string, CoverageFunction>
    f: Record<string, number>
    branchMap: Record<string, CoverageBranch>
    b: Record<string, number[]>
  }

  /** The istanbul tree node handed to `onDetail`. */
  export interface CoverageDetailNode {
    getFileCoverage(): UncoveredFileCoverage
  }

  /** The content writer istanbul's file writer hands out for `null`: the console. */
  export interface CoverageContentWriter {
    println(text: string): undefined
    close(): undefined
  }

  /** The istanbul report context fields the reporter uses. */
  export interface CoverageReportContext {
    writer: { writeFile(file: null): CoverageContentWriter }
  }
}

export = UncoveredLocationsReport
