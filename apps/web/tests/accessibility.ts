import { AxeBuilder } from '@axe-core/playwright'
import axe from 'axe-core'
import type { Page } from 'playwright'
import { expect } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REPO_ROOT } from './support.ts'

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
  if (audit.violations.length > 0 || audit.incomplete.length > 0) {
    const artifacts = join(REPO_ROOT, '.artifacts')
    await mkdir(artifacts, { recursive: true })
    const directory = await mkdtemp(join(artifacts, 'accessibility-'))
    await writeFile(join(directory, 'audit.json'), JSON.stringify(audit, null, 2))
    await writeFile(join(directory, 'page.html'), await page.content())
    await page.screenshot({ path: join(directory, 'page.png'), fullPage: true })
  }
  expect(audit.violations).toEqual([])
  expect(audit.incomplete).toEqual([])
  expect(audit.passes.length).toBeGreaterThan(0)
}
