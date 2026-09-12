'use strict';

/**
 * Istanbul coverage reporter writing one tab-separated line per measured
 * file into the reports directory: the path relative to the project root,
 * then `covered/total` for statements, branches, functions, and lines, in
 * that order. istanbul's own per-file summary supplies the counts, so a
 * consumer reads the gate's arithmetic instead of re-deriving it from the
 * raw range maps.
 *
 * `scripts/coverage-debt-measure.ts` runs the coverage lane with this
 * reporter and reads `file-totals.tsv` back. CommonJS for the reason
 * `coverage-uncovered-locations.cjs` states: istanbul-reports loads custom
 * reporters with a bare `require()`. `coverage-file-totals.d.cts` is the
 * declaration `coverage-file-totals.spec.ts` drives it through.
 */

const path = require('node:path');
const { ReportBase } = require('istanbul-lib-report');

/** File name written inside the coverage reports directory. */
const TOTALS_FILE = 'file-totals.tsv';

/** `covered/total` of one summary metric. */
function ratio(metric) {
  return `${metric.covered}/${metric.total}`;
}

class FileTotalsReport extends ReportBase {
  constructor(opts = {}) {
    super(opts);
    // Vitest passes the resolved config root alongside reporter options.
    this.projectRoot = opts.projectRoot || process.cwd();
    this.out = null;
  }

  onStart(_root, context) {
    this.out = context.writer.writeFile(TOTALS_FILE);
  }

  onDetail(node) {
    const fc = node.getFileCoverage();
    const rel = path.relative(this.projectRoot, fc.path).split(path.sep).join('/');
    const summary = fc.toSummary();
    this.out.println([
      rel,
      ratio(summary.statements),
      ratio(summary.branches),
      ratio(summary.functions),
      ratio(summary.lines),
    ].join('\t'));
  }

  onEnd() {
    this.out.close();
    this.out = null;
  }
}

FileTotalsReport.TOTALS_FILE = TOTALS_FILE;

module.exports = FileTotalsReport;
