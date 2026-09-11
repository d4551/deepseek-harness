import { readFile } from 'node:fs/promises'
import { chromium, webkit, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import AxeBuilder from '@axe-core/playwright'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'

const sourceId = SessionId('sidebar-source')
const unavailableId = SessionId('sidebar-unavailable')
const recording = new URL('../../../snapshots/web/seeded-history/session.jsonl', import.meta.url)

describe.each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('sidebar session actions in $name', ({ engine }) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    const history = await readFile(recording, 'utf8')
    await seedSession(scaffold, history, sourceId)
    await seedSession(scaffold, history, unavailableId, 'removed-preset')
    browser = await engine.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text())
    })
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor()
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })

  it('positions the right-click menu and commits Rename and Fork through the host', async () => {
    const row = page.locator(`[data-row-key="session:${sourceId}"]`)
    await row.click()
    await row.click({ button: 'right', position: { x: 100, y: 16 } })
    const menu = page.getByRole('menu')
    await menu.waitFor()
    const rowBox = await row.boundingBox()
    const menuBox = await menu.boundingBox()
    if (rowBox === null || menuBox === null) throw new Error('session menu has no layout box')
    expect(menuBox.x).toBeCloseTo(rowBox.x + 100, 0)
    expect(menuBox.y).toBeCloseTo(rowBox.y + 20, 0)
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1440)
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(1000)
    const menuAudit = await new AxeBuilder({ page }).analyze()
    expect(menuAudit.violations).toEqual([])
    expect(menuAudit.incomplete).toEqual([])
    await page.screenshot({ path: `.artifacts/finish/sidebar-menu-${engine.name()}.png` })
    await menu.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const rename = page.getByRole('dialog', { name: 'Rename session' })
    await rename.getByRole('textbox', { name: 'Session name' }).fill('Sidebar verification')
    await page.screenshot({ path: `.artifacts/finish/sidebar-rename-${engine.name()}.png` })
    await rename.getByRole('button', { name: 'Rename', exact: true }).click()
    await rename.waitFor({ state: 'hidden' })
    await expect.poll(() => row.textContent()).toContain('Sidebar verification')
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Fork session' }).click()
    await expect.poll(() => scaffold.ctx.agents.list().filter(
      agent => agent.session.header.parentSession === sourceId,
    ).length).toBe(1)
    const child = scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === sourceId)
    if (child === undefined) throw new Error('fork did not publish a child session')
    const childRow = page.locator(`[data-row-key="session:${child.session.id}"]`)
    await expect.poll(() => childRow.getAttribute('aria-current')).toBe('true')
    await expect.poll(() => childRow.textContent()).toContain('Sidebar verification (1)')
    await page.screenshot({ path: `.artifacts/finish/sidebar-fork-${engine.name()}.png` })
  })

  it('shows a preset failure without changing the current conversation', async () => {
    const current = await page.locator('[role="treeitem"][aria-current="true"]').getAttribute('data-row-key')
    const row = page.locator(`[data-row-key="session:${unavailableId}"]`)
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Fork session' }).click()
    const error = page.getByRole('dialog', { name: 'Couldn’t fork session' })
    await error.waitFor()
    const errorAudit = await new AxeBuilder({ page }).analyze()
    expect(errorAudit.violations).toEqual([])
    expect(errorAudit.incomplete).toEqual([])
    expect(await error.getByRole('alert').textContent()).toContain('removed-preset')
    expect(await page.locator('[role="treeitem"][aria-current="true"]').getAttribute('data-row-key')).toBe(current)
    expect(scaffold.ctx.agents.list().some(agent => agent.session.header.parentSession === unavailableId)).toBe(false)
    await page.screenshot({ path: `.artifacts/finish/sidebar-fork-error-${engine.name()}.png` })
    await error.getByRole('button', { name: 'Close', exact: true }).click()
    await error.waitFor({ state: 'hidden' })
  })

  it('retains the rename draft and displays the host refusal', async () => {
    const current = await page.locator('[role="treeitem"][aria-current="true"]').getAttribute('data-row-key')
    const row = page.locator(`[data-row-key="session:${unavailableId}"]`)
    const title = await row.textContent()
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Rename session' })
    const input = dialog.getByRole('textbox', { name: 'Session name' })
    await input.fill('Retained rename draft')
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
    await dialog.getByRole('alert').waitFor()
    expect(await dialog.getByRole('alert').textContent()).toContain('removed-preset')
    expect(await input.inputValue()).toBe('Retained rename draft')
    expect(await row.textContent()).toBe(title)
    expect(await page.locator('[role="treeitem"][aria-current="true"]').getAttribute('data-row-key')).toBe(current)
    const audit = await new AxeBuilder({ page }).analyze()
    expect(audit.violations).toEqual([])
    expect(audit.incomplete).toEqual([])
    await page.screenshot({ path: `.artifacts/finish/sidebar-rename-error-${engine.name()}.png` })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  })
})
