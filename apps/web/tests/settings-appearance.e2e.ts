// Web e2e scenarios: the Appearance preference row — the real theme gesture
// (click 深色 and the whole cascade runs: ThemeRuntime preference -> Host
// settings -> theme/change -> ui-layout's presenter -> body attribute -> alias
// token + browser theme-color metadata) — and the content font-size stepper
// applied to body and persisted across reload.
import type { Browser, Page } from 'playwright'
import type { Locator } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import {
  launchSettingsSuite, launchSharedHomeScaffold, readSettingsDocument,
} from '../settings-e2e-support.ts'

interface BootObservation {
  attr: boolean
  background: string
  colorScheme: string
}

describe('web e2e: settings appearance preferences', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const suite = await launchSettingsSuite()
    scaffold = suite.scaffold
    browser = suite.browser
    page = suite.page
    tripwire = suite.tripwire
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /**
   * Run one real theme gesture: open settings, click the named cube, and wait
   * for its pressed state to settle.
   */
  const chooseThemeCube = async (name: string): Promise<void> => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const cube = page.getByRole('dialog', { name: '设置' }).getByRole('button', { name })
    await cube.click()
    await expect.poll(() => cube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
  }

  it('uses the persisted dark preference while plugins are still loading', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-boot-theme'))
    await page.emulateMedia({ colorScheme: 'light' })
    await chooseThemeCube('深色')
    await expect.poll(async () => readSettingsDocument(scaffold), { timeout: 5_000 })
      .toMatch(/ui-theme:\n\s+preference: dark/)
    await page.keyboard.press('Escape')

    // Hold the real application batch so the shell-owned loading page remains observable.
    const pluginPattern = /\/plugins\/\?\?.+\/client\.js,.+\/client\.js&rev=[a-f\d]{12}$/
    const batch = Promise.withResolvers<boolean>()
    await page.route(pluginPattern, async (route) => {
      await batch.promise
      await route.continue()
    })

    const warningStart = tripwire.warnings.length
    const reload = page.reload({ waitUntil: 'domcontentloaded' })
    const [observed] = await Promise.allSettled([(async (): Promise<BootObservation> => {
      const loading = page.getByText('Loading plugins…', { exact: true })
      await loading.waitFor({ timeout: 10_000 })
      return await loading.evaluate((element) => {
        const boot = element.parentElement?.parentElement
        if (boot === undefined || boot === null) throw new Error('loading hint is detached from the boot page')
        return {
          attr: document.body.hasAttribute('data-ds-dark-theme'),
          background: getComputedStyle(boot).backgroundColor,
          colorScheme: document.documentElement.style.colorScheme,
        }
      })
    })()])
    batch.resolve(true)
    await reload
    await page.unroute(pluginPattern)
    if (observed === undefined || observed.status === 'rejected') {
      throw observed?.status === 'rejected' ? observed.reason : new Error('boot observation produced no result')
    }
    expect(observed.value).toEqual({
      attr: true,
      background: 'rgb(21, 21, 23)',
      colorScheme: 'dark',
    })

    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await chooseThemeCube('跟随系统')
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), {
      timeout: 5_000,
    }).toBe(false)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('flips the theme through the Appearance cubes and persists across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-appearance'))
    interface ThemeState {
      attr: boolean
      background: string
      themeColor: string | null
      themeColorCount: number
      token: string
    }
    const readState = async (target: Page = page): Promise<ThemeState> => await target.evaluate(() => {
      const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      const computed = getComputedStyle(document.body)
      return {
        attr: document.body.hasAttribute('data-ds-dark-theme'),
        background: computed.backgroundColor,
        themeColor: metas[0]?.content ?? null,
        themeColorCount: metas.length,
        token: computed.getPropertyValue('--dsw-alias-bg-base').trim(),
      }
    })
    const expectThemeColorSynchronized = (state: ThemeState): void => {
      expect(state.themeColorCount).toBe(1)
      expect(state.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(state.themeColor).toBe(state.background)
    }
    const expectBodyAttr = async (attr: boolean): Promise<void> => {
      await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(attr)
      expectThemeColorSynchronized(await readState())
    }
    // Pin the OS scheme to light so the default `system` preference resolves
    // light and the dark flip below is unambiguously the gesture's doing.
    await page.emulateMedia({ colorScheme: 'light' })
    const light = await readState()
    expect(light.attr).toBe(false)
    expectThemeColorSynchronized(light)

    await chooseThemeCube('深色')
    // The full cascade: pressed state, Host-backed preference, body attribute,
    // alias token flip — all from one real user gesture.
    const dark = await readState()
    expect(dark.attr).toBe(true)
    expect(dark.token).not.toBe(light.token)
    expectThemeColorSynchronized(dark)
    await expect.poll(async () => readSettingsDocument(scaffold), { timeout: 5_000 })
      .toMatch(/ui-theme:\n\s+preference: dark/)
    await page.keyboard.press('Escape')

    // Reload: the preference survives the background Host read + presenter update.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.emulateMedia({ colorScheme: 'light' })
    await expectBodyAttr(true)

    // A second live Host binds another ephemeral port but shares the same
    // user-settings home. Its fresh origin has no theme storage state and still
    // converges to dark before the settings dialog opens.
    const second = await launchSharedHomeScaffold(browser, scaffold)
    onTestFinished(second.close)
    expect(second.scaffold.baseUrl).not.toBe(scaffold.baseUrl)
    await second.page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(async () => (await readState(second.page)).attr, { timeout: 5_000 }).toBe(true)
    expectThemeColorSynchronized(await readState(second.page))
    expect(second.tripwire.pageErrors).toEqual([])
    expect(second.tripwire.warnings).toEqual([])

    // `system` follows the emulated OS scheme (dark stays dark, light clears).
    await chooseThemeCube('跟随系统')
    await expectBodyAttr(false)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expectBodyAttr(true)
    // Restore for the specs that follow: light preference beats the emulated
    // dark OS scheme, leaving the shared page in the light default.
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '浅色' }).click()
    await expectBodyAttr(false)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('steps the content font size, applies it to body, and persists across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-font-size'))
    const readFontSize = async (target: Page = page): Promise<string> => await target.evaluate(
      () => document.body.style.getPropertyValue('--dsh-content-font-size'),
    )
    // The secondary tier resolved by the real engine: a probe element's
    // font-size forces min/max/calc evaluation, which the CSS-text specs
    // cannot exercise. Setting −1 at ≤14, setting −2 above.
    const readSecondaryFontSize = async (): Promise<string> => await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.fontSize = 'var(--dsh-content-font-size-secondary, 13px)'
      document.body.appendChild(probe)
      const size = getComputedStyle(probe).fontSize
      probe.remove()
      return size
    })
    const stepFontSize = async (panel: Locator, direction: 'down' | 'up', from: string, to: string): Promise<void> => {
      await panel.getByText(from, { exact: true }).hover()
      const button = panel.getByRole('button', { name: direction === 'up' ? '增大字号' : '减小字号' })
      await button.click()
      await panel.getByText(to, { exact: true }).waitFor({ timeout: 5_000 })
    }
    expect(await readFontSize()).toBe('14px')
    expect(await readSecondaryFontSize()).toBe('13px')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    // The stepper reveals its arrows on hover; the up arrow steps 14 → 15 → 16.
    await stepFontSize(dialog, 'up', '14', '15')
    // 15 is the piecewise boundary: the secondary tier holds at 13px (−2)
    // where the ≤14 branch would have given 14px (−1).
    await expect.poll(readSecondaryFontSize, { timeout: 5_000 }).toBe('13px')
    await stepFontSize(dialog, 'up', '15', '16')
    await expect.poll(async () => readFontSize(), { timeout: 5_000 }).toBe('16px')
    await expect.poll(readSecondaryFontSize, { timeout: 5_000 }).toBe('14px')
    await expect.poll(async () => readSettingsDocument(scaffold), { timeout: 5_000 })
      .toMatch(/ui-theme:\n(?:\s+\w+: .*\n)*?\s+fontSize: 16/)
    await page.keyboard.press('Escape')

    // Reload: the boot script embeds the durable size and ThemeRuntime seeds
    // its initial snapshot from the boot-written body variable, so activation
    // never flashes the default while the settings read is in flight.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(async () => readFontSize(), { timeout: 5_000 }).toBe('16px')
    expect(await readSecondaryFontSize()).toBe('14px')

    // Restore the default for the specs that follow (and the dialog golden).
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const restored = page.getByRole('dialog', { name: '设置' })
    await restored.waitFor({ timeout: 10_000 })
    await stepFontSize(restored, 'down', '16', '15')
    await stepFontSize(restored, 'down', '15', '14')
    await expect.poll(async () => readFontSize(), { timeout: 5_000 }).toBe('14px')
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
