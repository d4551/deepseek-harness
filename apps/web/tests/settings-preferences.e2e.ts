// Web e2e scenarios: the Host-backed preferences that survive reload and a
// distinct port — completed-Turn transcript mode, busy-state Enter behavior,
// and the settings language — plus the locale-detection fallback pair (an
// English browser and a browser asking for no shipped language). Zero model
// calls: everything is pure client + persistence state.
import type { Browser, Page } from 'playwright'
import type { Locator } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, webSnapshotMode, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import {
  launchSettingsSuite, launchSharedHomeScaffold, readSettingsDocument, settingsGoldens,
} from '../settings-e2e-support.ts'

const goldens = settingsGoldens()
const MODE = webSnapshotMode()

describe('web e2e: settings language and Enter preferences', () => {
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

  const openSettings = async (): Promise<Locator> => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    return dialog
  }

  const reloadToFrame = async (): Promise<void> => {
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
  }

  const expectPersisted = async (pattern: RegExp): Promise<void> => {
    await expect.poll(async () => readSettingsDocument(scaffold), { timeout: 5_000 }).toMatch(pattern)
    await page.keyboard.press('Escape')
  }

  const reopenAfterReload = async (pattern: RegExp): Promise<Locator> => {
    await expectPersisted(pattern)
    await reloadToFrame()
    return openSettings()
  }

  const chooseMenuAction = async (panel: Locator, row: string, action: string): Promise<void> => {
    await panel.getByRole('button', { name: row, exact: true }).click()
    await page.getByRole('menuitem', { name: action, exact: true }).click()
    await panel.getByRole('button', { name: action, exact: true }).waitFor({ timeout: 10_000 })
  }

  const openSharedHomeSettings = async (dialogName: string, row: string): Promise<void> => {
    const second = await launchSharedHomeScaffold(browser, scaffold)
    onTestFinished(second.close)
    expect(second.scaffold.baseUrl).not.toBe(scaffold.baseUrl)
    await second.page.getByRole('button', { name: dialogName, exact: true }).click()
    await second.page.getByRole('dialog', { name: dialogName })
      .getByRole('button', { name: row }).waitFor({ timeout: 10_000 })
    expect(second.tripwire.pageErrors).toEqual([])
    expect(second.tripwire.warnings).toEqual([])
  }

  it('persists the completed-Turn transcript mode across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-transcript-view'))
    const dialog = await openSettings()
    await dialog.getByText('对话显示', { exact: true }).waitFor({ timeout: 10_000 })
    await chooseMenuAction(dialog, '紧凑', '普通')
    await expectPersisted(/ui-chat:\n\s+transcriptView: normal/)

    const reloaded = await reopenAfterReload(/ui-chat:\n\s+transcriptView: normal/)
    await chooseMenuAction(reloaded, '普通', '紧凑')
    await expectPersisted(/ui-chat:\n\s+transcriptView: compact/)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('persists the busy-state Enter behavior across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-enter-behavior'))
    const dialog = await openSettings()
    await chooseMenuAction(dialog, '排队发送', '插话发送')
    await expectPersisted(/ui-conversation:\n\s+busyEnter: steer/)

    const reloaded = await reopenAfterReload(/ui-conversation:\n\s+busyEnter: steer/)
    await reloaded.getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })
    await openSharedHomeSettings('设置', '插话发送')

    await chooseMenuAction(reloaded, '插话发送', '排队发送')
    await expectPersisted(/ui-conversation:\n\s+busyEnter: queue/)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('persists the settings language across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-language'))
    const zhDialog = await openSettings()
    // The document language follows the active locale in the assembled app, not
    // only on a directly-mounted plugin. This is a zh browser, so the served
    // markup's `en` must already have been replaced — asserting it here (rather
    // than only in an English scenario) is what makes the check discriminating.
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN')
    // The Language selector pill shows the active locale's own name.
    const selector = zhDialog.getByRole('button', { name: '中文' })
    expect(await selector.getAttribute('aria-haspopup')).toBe('menu')
    await selector.click()
    await page.getByRole('menuitem', { name: 'English' }).click()
    // The settings-owned copy re-registers localized: dialog title, nav,
    // Appearance labels. (Only the settings namespaces are localized —
    // the rest of the app's copy is intentionally out of this row's scope.)
    const enDialog = page.getByRole('dialog', { name: 'Settings' })
    await enDialog.waitFor({ timeout: 10_000 })
    // ...and the attribute follows that switch, in the assembled app.
    await expect.poll(() => page.evaluate(() => document.documentElement.lang), { timeout: 5_000 }).toBe('en')
    expect(await enDialog.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    await expect.poll(() => enDialog.getByText('Appearance', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    await expectPersisted(/locale:\n\s+preference: en/)

    // Reload keeps English; then restore zh so shared page state (and the
    // other specs' 设置-anchored selectors + goldens) see the default again.
    await reloadToFrame()
    const enTrigger = page.getByRole('button', { name: 'Settings' })
    await enTrigger.waitFor({ timeout: 10_000 })
    await openSharedHomeSettings('Settings', 'English')

    await enTrigger.click()
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'English' }).click()
    await page.getByRole('menuitem', { name: '中文' }).click()
    await page.getByRole('dialog', { name: '设置' }).waitFor({ timeout: 10_000 })
    await expectPersisted(/locale:\n\s+preference: zh/)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  /**
   * Launch a fresh-home scaffold whose page presents the requested locale and
   * has the English settings dialog open, registered for test-end teardown.
   */
  const openEnglishFallbackDialog = async (locale: string, shotName: string): Promise<{
    fresh: WebScaffold
    page: Page
    tripwire: ReturnType<typeof watchConsole>
    dialog: Locator
  }> => {
    const fresh = await launchWebScaffold({})
    const localePage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale })
    const localeTripwire = watchConsole(localePage)
    onTestFinished(async () => {
      await localePage.close()
      await fresh.close()
    })
    onTestFailed(() => saveFailureShot(localePage, shotName))
    await localePage.goto(fresh.authenticatedUrl, { waitUntil: 'load' })
    await localePage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await localePage.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = localePage.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'English' }).waitFor({ timeout: 10_000 })
    return { fresh, page: localePage, tripwire: localeTripwire, dialog }
  }

  it('opens an English browser in English without any stored preference', async () => {
    // A fresh Host home has no locale preference, so its surface follows the
    // browser. English is also FALLBACK_LOCALE, so this scenario alone cannot
    // distinguish detection from the default — the zh scenarios above supply
    // the discriminating half (a Chinese browser must NOT land on the default).
    const { tripwire: enTripwire } = await openEnglishFallbackDialog('en-US', 'web-e2e-settings-browser-language')
    // This page has no closing inventory spec to sweep its console, so the
    // scenario clears both tripwire channels itself.
    expect(enTripwire.pageErrors).toEqual([])
    expect(enTripwire.warnings).toEqual([])
  }, 90_000)

  it('opens a browser asking for no shipped language in English', async () => {
    // The product default for "no usable signal": a French browser ships
    // neither zh nor en, so resolution falls to FALLBACK_LOCALE (en) rather
    // than to Chinese.
    const { fresh, page: frPage, tripwire: frTripwire, dialog } = await openEnglishFallbackDialog('fr-FR', 'web-e2e-settings-unshipped-language')
    const preset = dialog.getByRole('button', { name: 'Standard mode' })
    await expect.poll(() => preset.isEnabled(), { timeout: 10_000 }).toBe(true)
    // The markup already ships `en`, so this alone cannot prove the sync ran
    // — the zh scenario above is the discriminating half. Asserted here too
    // so a future change that resolves en but writes the wrong tag is caught.
    expect(await frPage.evaluate(() => document.documentElement.lang)).toBe('en')
    // Golden of the English fallback dialog — the visible output this change
    // produces. The zh golden above covers the detected-locale surface, so
    // the pair pins both directions of the resolution.
    const snapshot = await captureStableAria(frPage, '[role="dialog"]', fresh.workspaceCwd)
    await compareOrRefreshGolden(goldens.dialogEn, snapshot, MODE)
    expect(frTripwire.pageErrors).toEqual([])
    expect(frTripwire.warnings).toEqual([])
  }, 90_000)
})
