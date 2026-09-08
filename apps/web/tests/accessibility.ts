import { AxeBuilder } from '@axe-core/playwright'
import axe from 'axe-core'
import type { Page } from 'playwright'
import { expect } from 'vitest'

/**
 * Audit the rendered page and its frames with WCAG 2.2 rules enabled.
 * @param page - the assembled application page in its current interaction state.
 * @returns when every reported check has a decided, passing result.
 */
export async function assertPageAccessibility(page: Page): Promise<void> {
  const rules = Object.fromEntries(axe.getRules(['wcag22a', 'wcag22aa']).map(rule => [
    rule.ruleId, { enabled: true },
  ]))
  const audit = await new AxeBuilder({ page }).options({ rules }).analyze()
  expect(audit.violations).toEqual([])
  expect(audit.incomplete).toEqual([])
  expect(audit.passes.length).toBeGreaterThan(0)
}
