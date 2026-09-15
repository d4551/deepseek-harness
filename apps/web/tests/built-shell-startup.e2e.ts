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
  })

  afterAll(async () => {
    await Promise.all([browser?.close(), scaffold?.close()])
  })

  it('initializes the shared runtime before the entry runs, including a cached reload', async () => {
    if (scaffold === undefined) throw new Error('Startup verification requires a running web scaffold')
    for (const navigation of ['cold', 'reload']) {
      // Onboarding reads start after the shell appears and must finish before its document is replaced.
      const onboarding = Promise.all([
        'llm/listProviders',
        'llm/listConfigurableProviders',
        'credentials/describe',
      ].map(async (endpoint) => {
        let rpcId: string | undefined
        const response = await page.waitForResponse(
          (response) => {
            const request = response.request()
            if (request.method() !== 'POST' || request.headers()['content-type'] !== 'application/json') return false
            const message: unknown = request.postDataJSON()
            if (typeof message !== 'object' || message === null
              || !('type' in message) || message.type !== 'client-request'
              || !('method' in message) || message.method !== endpoint) return false
            if (!('rpcId' in message) || typeof message.rpcId !== 'string') {
              throw new Error(`Startup request ${endpoint} requires a correlation id`)
            }
            rpcId = message.rpcId
            return true
          },
          { timeout: 10_000 },
        )
        expect(response.status()).toBe(200)
        expect(await response.finished()).toBeNull()
        expect(await response.json()).toMatchObject({ type: 'server-response', rpcId, result: { ok: true } })
      }))
      await Promise.all([
        onboarding,
        navigation === 'cold' ? page.goto(scaffold.authenticatedUrl) : page.reload(),
      ])
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
