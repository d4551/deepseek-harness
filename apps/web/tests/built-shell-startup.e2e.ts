import { chromium, webkit, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

describe.each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('built shell startup in $name', ({ engine }) => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  const errors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await engine.launch()
    page = await browser.newPage({ locale: 'en-US' })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
    })
    await page.goto(scaffold.authenticatedUrl)
  })

  afterAll(async () => {
    await Promise.all([browser?.close(), scaffold?.close()])
  })

  it('initializes the shared runtime before the entry runs, including a cached reload', async () => {
    for (const navigation of ['cold', 'reload']) {
      if (navigation === 'reload') await page.reload()
      await expect.poll(async () => ({
        errors: [...errors],
        bootScreens: await page.locator('[data-dsh-boot]').count(),
        newSessionVisible: await page.getByRole('button', { name: 'New session', exact: true }).first().isVisible(),
        settingsVisible: await page.getByRole('button', { name: 'Settings', exact: true }).isVisible(),
      }), { timeout: 10_000 }).toEqual({
        errors: [],
        bootScreens: 0,
        newSessionVisible: true,
        settingsVisible: true,
      })
    }
  })
})
