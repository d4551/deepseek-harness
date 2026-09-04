// Web e2e scenarios: the settings modal shell — trigger, nav, section
// switching, both close paths — and Permission as the persisted default for
// subsequently created sessions. Zero model calls: everything is pure client +
// persistence state on a blank frame, so there is no fixture and a stray
// stream would fail loud on the open llm seam.
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  webSnapshotMode, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'
import { launchSettingsSuite, readSettingsDocument, settingsGoldens } from '../settings-e2e-support.ts'

const goldens = settingsGoldens()
const MODE = webSnapshotMode()

describe('web e2e: settings modal and General preferences', () => {
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
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens the settings dialog, switches sections, and closes by every path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-shell'))
    const trigger = page.getByRole('button', { name: '设置', exact: true })
    expect(await trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    // General is active by default; Permission, Language and Appearance are functional.
    expect(await dialog.getByRole('button', { name: '通用设置' }).getAttribute('aria-current')).toBe('true')
    await dialog.getByRole('button', { name: 'Workspace Write' }).waitFor({ timeout: 10_000 })
    await expect.poll(() => dialog.getByText('语言', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => dialog.getByText('外观', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    const openDocument = dialog.getByRole('button', { name: '打开配置文件' })
    await openDocument.waitFor({ timeout: 10_000 })
    let openRequests = 0
    await page.route('**/api/settings/openSettingsDocument', async (route) => {
      const envelope: { rpcId: string; payload: { args: Record<string, never> } } = route.request().postDataJSON()
      expect(envelope.payload).toEqual({ args: {} })
      openRequests += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: { opened: true } },
        }),
      })
    })
    await openDocument.click()
    await expect.poll(() => openRequests, { timeout: 5_000 }).toBe(1)
    await expect.poll(() => openDocument.isEnabled(), { timeout: 5_000 }).toBe(true)
    await page.unroute('**/api/settings/openSettingsDocument')
    // Golden of the freshly opened dialog (default zh, General active).
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(goldens.dialog, snapshot, MODE)
    // Section switch: aria-current moves (the Models page itself has its own scenario file).
    await dialog.getByRole('button', { name: '模型' }).click()
    await expect.poll(() => dialog.getByRole('button', { name: '模型' }).getAttribute('aria-current'), { timeout: 5_000 }).toBe('true')
    expect(await dialog.getByRole('button', { name: '通用设置' }).getAttribute('aria-current')).toBeNull()
    // Plugins is a read-only projection of the same assembled Loader tree.
    // Capture one stable shipped row rather than the whole inventory so adding
    // an unrelated plugin does not rewrite this surface's golden.
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await dialog.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('tab', { name: '插件列表', exact: true }).click()
    const pluginRow = dialog.locator('[data-plugin-entry$="ui-settings"]')
    await pluginRow.waitFor({ timeout: 10_000 })
    const expectedPluginCount = [...scaffold.ctx.loader.entries()]
      .filter(entry => !entry.options.group)
      .length
    expect(await dialog.getByRole('searchbox', { name: '搜索插件' }).count()).toBe(1)
    expect(await dialog.locator('[data-plugin-entry]').count()).toBe(expectedPluginCount)
    expect(await dialog.locator('[data-plugin-count]').getAttribute('data-plugin-count'))
      .toBe(String(expectedPluginCount))
    expect(await dialog.getByRole('button', { name: '插件', exact: true }).getAttribute('aria-current')).toBe('true')
    expect(await dialog.getByRole('tab', { name: '插件列表', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await dialog.getByRole('button', { name: '模型' }).getAttribute('aria-current')).toBeNull()
    const pluginsSnapshot = await captureStableAria(
      page,
      '[data-plugin-entry$="ui-settings"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(goldens.plugins, pluginsSnapshot, MODE)
    // Close path 1: Escape.
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    // Close path 2: the header close button (focus lands there on open).
    await trigger.click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stores Permission as the default for future sessions without changing an existing session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-permission'))
    const existing = scaffold.ctx.sessions.create(SessionId('settings-permission-before'))
    expect(existing.events.find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    const selector = dialog.getByRole('button', { name: 'Workspace Write' })
    await selector.waitFor({ timeout: 10_000 })
    await expect.poll(() => selector.isEnabled(), { timeout: 5_000 }).toBe(true)
    await selector.click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await dialog.getByRole('button', { name: 'Read Only' }).waitFor({ timeout: 10_000 })

    const document = await readSettingsDocument(scaffold)
    expect(document).toContain('permission:')
    expect(document).toContain('defaultPreset: read-only')
    expect(existing.events.find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    const created = scaffold.ctx.sessions.create(SessionId('settings-permission-after'))
    expect(created.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'read-only' }],
      ['sandbox/mode', { mode: 'read-only' }],
      ['approval/policy', { policy: 'ask' }],
    ])

    await dialog.getByRole('button', { name: 'Read Only' }).click()
    await page.getByRole('menuitem', { name: 'Full access' }).click()
    const confirmation = page.getByRole('dialog', { name: '确认启用 Full access？' })
    const enable = confirmation.getByRole('button', { name: '启用 Full access' })
    expect(await enable.isDisabled()).toBe(true)
    await confirmation.getByRole('checkbox').click()
    await enable.click()
    await dialog.getByRole('button', { name: 'Full access' }).waitFor({ timeout: 10_000 })
    const confirmedDocument = await readSettingsDocument(scaffold)
    expect(confirmedDocument).toContain('defaultPreset: danger-full-access')
    const confirmed = scaffold.ctx.sessions.create(SessionId('settings-permission-confirmed'))
    expect(confirmed.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    // The golden refresh writes the inventory it just rewrote, so the closed
    // set pins verification runs only.
    if (MODE !== 'record') {
      await assertFixtureInventory(goldens.snapshotDir, ['dialog-en.expected.md', 'dialog.expected.md', 'plugins.expected.md'])
    }
  })
})
