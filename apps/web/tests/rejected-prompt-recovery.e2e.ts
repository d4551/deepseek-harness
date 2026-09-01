// Web e2e regression: the composer must surface host prompt rejections
// instead of stalling. Driven through the real served app with the client
// fixture mock backend: ?fixture&fixturePrompt=reject makes every
// session.prompt RPC resolve { ok: false, code: 'agent-busy' } — the same
// client pipeline as any host rejection (model-unavailable / agent-busy /
// attachment-error).
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MARK = 'REJECTED_PROMPT_MARKER'

describe('web e2e: rejected prompt surfaces instead of stalling', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 900)
    // The token exchange redirects to '/' and drops the query; revisit with
    // the fixture switches once the session cookie is in place.
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.goto(`${scaffold.baseUrl}/?fixture&fixturePrompt=reject`, { waitUntil: 'load' })
    await page.waitForSelector('[data-composer-input]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows a rejection alert, re-enables the composer, and preserves the draft', { timeout: 120_000 }, async () => {
    const tripwire = watchConsole(page)
    onTestFailed(async () => { await saveFailureShot(page, 'rejected-prompt') })

    const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
    // Fixture picker surface: open the dialog and accept the offered path
    // when the composer is not yet live.
    if (await composer.count() === 0) {
      await page.getByRole('textbox', { name: 'Choose workspace' }).click({ timeout: 10_000 })
      const dialog = page.getByRole('dialog')
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    }
    await composer.waitFor({ timeout: 15_000 })

    // Fixture settings writes fail, so the welcome notice never
    // acknowledges; dismiss it to unblock the composer.
    const continueButton = page.getByRole('button', { name: 'Continue' })
    if (await continueButton.count() > 0) await continueButton.click()

    await composer.click()
    await page.keyboard.type(`Rejected prompt probe ${MARK}`, { delay: 8 })
    await page.getByRole('button', { name: 'Send message', exact: true }).click()

    // Contract: a rejected prompt must reach the user as an alert within a
    // bounded window — never a silent indefinite stall.
    const alert = page.getByRole('alert').filter({ hasText: /busy|unavailable|failed|error|reject/i })
    await expect.poll(() => alert.count(), { timeout: 30_000 }).toBeGreaterThan(0)

    // Contract: the composer must return to an editable (non-busy) state so
    // the session stays usable after a rejection.
    await expect.poll(() => composer.getAttribute('contenteditable'), { timeout: 30_000 }).toBe('true')
    // No stop affordance may linger once the rejection has been delivered.
    await expect.poll(() => page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 5_000 }).toBe(0)

    // The rejected draft text is preserved in the transcript or the draft —
    // either is acceptable; losing it entirely is data loss.
    const body = await page.locator('body').innerText()
    const preserved = body.includes(MARK) || (await composer.textContent() ?? '').includes(MARK)
    expect(preserved, 'rejected draft text must survive somewhere visible').toBe(true)

    expect(tripwire.pageErrors, 'no console page errors during rejection').toEqual([])
    expect(tripwire.warnings, 'no console warnings during rejection').toEqual([])
  })
})
