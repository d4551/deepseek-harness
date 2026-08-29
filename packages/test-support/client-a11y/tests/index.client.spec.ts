import { describe, expect, it } from 'vitest'
import type { Result } from 'axe-core'
import { accessibilityScore, CLIENT_AXE_TAGS, formatViolations } from '../src/index.ts'
import type { SurfaceAudit } from '../src/index.ts'

/** One violated rule over `targets`, with `impact` left off when not supplied. */
function violation(id: string, help: string, targets: string[][], impact?: Result['impact']): Result {
  return {
    id,
    help,
    ...impact === undefined ? {} : { impact },
    nodes: targets.map(target => ({ target })),
  } as Result
}

function audit(surface: string, over: Partial<SurfaceAudit> = {}): SurfaceAudit {
  return { surface, violations: [], passed: 0, failed: 0, undecided: 0, ...over }
}

describe('accessibilityScore', () => {
  it('reports the percentage of decided checks that passed', () => {
    expect(accessibilityScore([audit('a', { passed: 99, failed: 1 })])).toBe(99)
    expect(accessibilityScore([audit('a', { passed: 3, failed: 1 })])).toBe(75)
  })

  it('sums every surface rather than averaging their scores', () => {
    // One clean surface must not lift a failing one to 50%.
    expect(accessibilityScore([
      audit('clean', { passed: 1, failed: 0 }),
      audit('broken', { passed: 0, failed: 3 }),
    ])).toBe(25)
  })

  it('ignores undecided checks, which belong to neither side', () => {
    expect(accessibilityScore([audit('a', { passed: 1, failed: 1, undecided: 98 })])).toBe(50)
  })

  it('scores audits that decided nothing as 100, since nothing failed', () => {
    expect(accessibilityScore([])).toBe(100)
    expect(accessibilityScore([audit('empty'), audit('also-empty', { undecided: 4 })])).toBe(100)
  })
})

describe('formatViolations', () => {
  it('renders one line per offending node, naming rule, impact, target, and help', () => {
    const subject = audit('Button', {
      failed: 2,
      violations: [violation('button-name', 'Buttons must have discernible text', [['.a'], ['#b', 'span']], 'critical')],
    })

    expect(formatViolations(subject)).toBe(
      'Button: button-name (critical) at .a — Buttons must have discernible text\n'
      + 'Button: button-name (critical) at #b span — Buttons must have discernible text',
    )
  })

  it('names a rule that carries no impact rather than printing nothing', () => {
    const subject = audit('Menu', { failed: 1, violations: [violation('region', 'All content in landmarks', [['main']])] })

    expect(formatViolations(subject)).toBe('Menu: region (no impact) at main — All content in landmarks')
  })

  it('renders an empty string for a clean surface', () => {
    expect(formatViolations(audit('Pill', { passed: 12 }))).toBe('')
  })
})

describe('CLIENT_AXE_TAGS', () => {
  it('holds every audited surface to WCAG A, AA, and best practice', () => {
    // Narrowing this list weakens every suite at once, so its contents are pinned.
    expect([...CLIENT_AXE_TAGS]).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
  })
})
