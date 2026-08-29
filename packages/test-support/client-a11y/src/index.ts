/**
 * axe-core accessibility auditing for the jsdom client lane.
 *
 * A surface is one rendered DOM subtree. Auditing reports the rule-node checks
 * that passed and failed, so a suite can both reject individual violations and
 * report one aggregate score across every surface it rendered. Incomplete
 * results — checks axe cannot decide without a real layout engine, such as
 * colour contrast under jsdom — are reported separately and count toward
 * neither side, because scoring them either way would misstate the audit.
 * @module @deepseek-ai/dsh-client-a11y
 */
import axe from 'axe-core'
import type { ElementContext, Result, RunOptions } from 'axe-core'

/**
 * Rule tags every audited client surface is held to: WCAG 2.0/2.1 levels A and
 * AA plus axe's best-practice set. Narrowing this list weakens every suite at
 * once, so it is fixed here rather than passed in per call.
 */
export const CLIENT_AXE_TAGS: readonly string[] = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

/** One rendered surface's accessibility outcome. */
export interface SurfaceAudit {
  /** Caller-supplied surface name, used in failure output. */
  readonly surface: string
  /** Violated rules, each carrying the offending nodes. */
  readonly violations: readonly Result[]
  /** Rule-node checks that passed. */
  readonly passed: number
  /** Rule-node checks that failed. */
  readonly failed: number
  /** Rule-node checks axe could not decide in this environment. */
  readonly undecided: number
  /**
   * The rules those undecided checks belong to. Reported so a suite can assert
   * WHICH rules its environment cannot decide: undecided checks are excluded
   * from {@link accessibilityScore}, and without this a newly undecidable rule
   * would leave the score untouched instead of failing.
   */
  readonly undecidedRules: readonly string[]
}

/** Total nodes across a rule result list. */
function nodeCount(results: readonly Result[]): number {
  return results.reduce((total, result) => total + result.nodes.length, 0)
}

/**
 * Run axe over one rendered surface.
 * @param surface - name reported when the surface fails.
 * @param context - the element or selector axe should audit.
 * @returns the surface's passed/failed/undecided node counts and its violations.
 */
export async function auditSurface(surface: string, context: ElementContext): Promise<SurfaceAudit> {
  const options: RunOptions = { runOnly: { type: 'tag', values: [...CLIENT_AXE_TAGS] }, resultTypes: ['violations', 'incomplete', 'passes'] }
  const results = await axe.run(context, options)
  return {
    surface,
    violations: results.violations,
    passed: nodeCount(results.passes),
    failed: nodeCount(results.violations),
    undecided: nodeCount(results.incomplete),
    undecidedRules: results.incomplete.map(result => result.id),
  }
}

/**
 * Aggregate accessibility score over audited surfaces.
 * @param audits - every surface the suite rendered.
 * @returns the percentage of decided rule-node checks that passed; `100` when
 *   the audits decided nothing, since there is no failure to report.
 */
export function accessibilityScore(audits: readonly SurfaceAudit[]): number {
  const passed = audits.reduce((total, audit) => total + audit.passed, 0)
  const failed = audits.reduce((total, audit) => total + audit.failed, 0)
  const decided = passed + failed
  return decided === 0 ? 100 : (passed / decided) * 100
}

/**
 * Render one surface's violations for an assertion message.
 * @param audit - the surface to describe.
 * @returns one line per violated node, or an empty string when the surface is clean.
 */
export function formatViolations(audit: SurfaceAudit): string {
  return audit.violations.flatMap(violation => violation.nodes.map(
    node => `${audit.surface}: ${violation.id} (${violation.impact ?? 'no impact'}) at ${node.target.join(' ')} — ${violation.help}`,
  )).join('\n')
}
