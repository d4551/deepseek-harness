// Keyless assembled-browser coverage for the Agent Teams panel the shipped Web
// bundle mounts, over the real Host Typert Remote flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, launchBrowser, newEnglishPage, saveFailureShot } from './support.ts'
import { assertPageAccessibility } from './accessibility.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-team-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'task.expected.md')
const MODE = webSnapshotMode()
const COLOR_SCHEMES: Array<'light' | 'dark'> = ['light', 'dark']

describe.each(COLOR_SCHEMES)('web e2e: Agent Teams panel (%s)', (colorScheme) => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const tripwire: { warnings: string[]; pageErrors: string[] } = { warnings: [], pageErrors: [] }

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await launchBrowser()
    page = await newEnglishPage(browser)
    await page.emulateMedia({ colorScheme })
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') tripwire.warnings.push(message.text())
    })
    page.on('pageerror', (error) => { tripwire.pageErrors.push(String(error)) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    expect(await page.locator('body').getAttribute('data-ds-dark-theme')).toBe(colorScheme === 'dark' ? '' : null)
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('connected Team workspace did not create an Agent')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Open the Agent Team controls.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Ready.' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(agent.session)
    await page.getByText('Ready.').waitFor({ timeout: 10_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('loads the roster and creates one shared task through generated Remote', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const action = page.locator('[data-team-action]')
    await action.getByRole('button', { name: /Agent Team/iu }).click()
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    await panel.getByText('No shared tasks yet').waitFor()
    await panel.getByText('lead', { exact: true }).waitFor()
    const close = panel.getByRole('button', { name: 'Close', exact: true })
    const newTask = panel.getByRole('button', { name: 'New task', exact: true })
    await close.focus()
    await close.press('Shift+Tab')
    expect(await newTask.evaluate(button => document.activeElement === button)).toBe(true)
    await newTask.press('Tab')
    expect(await close.evaluate(button => document.activeElement === button)).toBe(true)
    await assertPageAccessibility(page)
    for (const viewport of [{ width: 840, height: 1000 }, { width: 600, height: 480 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(async () => {
        const bounds = await panel.boundingBox()
        return bounds !== null && bounds.x >= 0 && bounds.y >= 0
          && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height
      }).toBe(true)
    }
    await page.setViewportSize({ width: 1680, height: 1000 })

    await panel.getByRole('button', { name: 'New task' }).click()
    await assertPageAccessibility(page)
    await panel.getByRole('textbox', { name: 'Task subject', exact: true }).fill('Browser task')
    await panel.getByRole('textbox', { name: 'Task description', exact: true }).fill('Created through the assembled browser')
    await panel.getByRole('textbox', { name: /Write scopes/iu }).fill('src/web')
    await assertPageAccessibility(page)
    await panel.getByRole('textbox', { name: 'Task subject', exact: true }).press('Enter')
    await panel.getByText('Browser task').waitFor()

    const snapshot = await captureStableAria(page, '[role="dialog"][aria-label="Agent Team"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)
    const lead = scaffold.ctx.agents.list()[0]
    if (lead === undefined) throw new Error('Team lead is unavailable')
    const external = await scaffold.ctx.agentTeams.createTask(lead, {
      subject: 'Task created outside the panel',
      description: 'Live update from another Team client',
    })
    await panel.getByText('Task created outside the panel', { exact: true }).waitFor()
    await scaffold.ctx.agentTeams.updateTask(lead, {
      taskId: external.id,
      expectedRevision: external.revision,
      action: 'edit',
      subject: 'Task updated outside the panel',
    })
    await panel.getByText('Task updated outside the panel', { exact: true }).waitFor()
    const workspace = scaffold.ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(lead.id))
    if (workspace === undefined) throw new Error('Team workspace is unavailable')
    const peer = (await scaffold.ctx.agents.create({
      sessionId: SessionId(`team-reviewer-${colorScheme}`),
      meta: { cwd: workspace.path }, agentOptions: {},
    })).agent
    await workspace.attachSession(peer.id)
    const target = scaffold.ctx.agentTeams.listMembers(lead).find(member => member.id === peer.id)
    const sender = scaffold.ctx.agentTeams.listMembers(peer).find(member => member.id === lead.id)
    if (target === undefined || sender === undefined) throw new Error('Registered Team peers are unavailable')
    const signal = new AbortController().signal
    const request = await scaffold.ctx.agentTeams.sendMessage(lead, {
      target: target.name, content: [{ type: 'text', text: 'Please review the task changes.\nCheck keyboard navigation too.' }],
      delivery: 'quiet', signal,
    })
    const reply = await scaffold.ctx.agentTeams.sendMessage(peer, {
      target: sender.name, content: [{ type: 'text', text: 'Review complete. Keyboard navigation works.' }],
      delivery: 'quiet', signal,
    })
    expect(request.status).toBe('accepted')
    expect(reply.status).toBe('accepted')
    const messages = panel.getByRole('log', { name: 'Messages between members' })
    await messages.getByText('Review complete. Keyboard navigation works.', { exact: true }).waitFor()
    await expect.poll(() => messages.getByText('Delivered', { exact: true }).count()).toBe(2)
    expect(await messages.getByText('Queued', { exact: true }).count()).toBe(0)
    expect(await messages.innerText()).toContain('Please review the task changes.\nCheck keyboard navigation too.')
    expect(await messages.innerText()).toContain(`${target.name} → lead`)
    await assertPageAccessibility(page)
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
    await action.getByRole('button', { name: /Agent Team/iu }).click()
    await panel.getByText('Task updated outside the panel', { exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
    await assertPageAccessibility(page)
    expect(tripwire.warnings).toEqual([])
    await page.screenshot({ path: `.artifacts/finish/team-tasks-${colorScheme}.png` })
    await page.setViewportSize({ width: 390, height: 844 })
    await assertPageAccessibility(page)
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: `.artifacts/finish/team-tasks-mobile-${colorScheme}.png` })
    const conversations = panel.getByRole('region', { name: 'Subagent conversations', exact: true })
    await conversations.scrollIntoViewIfNeeded()
    const headingBounds = await conversations.getByRole('heading').boundingBox()
    const refreshBounds = await conversations.getByRole('button', { name: 'Refresh conversations' }).boundingBox()
    if (headingBounds === null || refreshBounds === null) throw new Error('Conversation controls are not visible')
    expect(refreshBounds.y).toBeGreaterThanOrEqual(headingBounds.y + headingBounds.height)
    await page.screenshot({ path: `.artifacts/finish/team-tasks-mobile-controls-${colorScheme}.png` })
    const teamTypography = await panel.getByRole('heading', { name: 'Agent Team', exact: true }).evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight]
    })
    expect(await close.isVisible()).toBe(true)
    expect(await panel.locator('[style]').evaluateAll(elements => elements.map(element => element.outerHTML))).toEqual([])
    const slotDisplays = await page.locator('[data-slot]').evaluateAll(elements =>
      elements.map(element => getComputedStyle(element).display))
    expect(slotDisplays.length).toBeGreaterThan(0)
    expect(new Set(slotDisplays)).toEqual(new Set(['contents']))
    await close.click()
    await page.setViewportSize({ width: 1680, height: 1000 })
    const settingsTrigger = page.getByRole('button', { name: 'Settings', exact: true })
    await settingsTrigger.click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const settingsTypography = await settings.getByRole('heading', { name: 'Settings', exact: true }).evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight]
    })
    expect(settingsTypography).toEqual(teamTypography)
    expect(await settings.locator('[style]').count()).toBe(0)
    await assertPageAccessibility(page)
    await page.screenshot({ path: `.artifacts/finish/settings-${colorScheme}.png` })
    const settingsBounds = await settings.getByRole('button', { name: 'General', exact: true }).boundingBox()
    for (const section of ['Models', 'Plugins', 'Agent presets']) {
      await settings.getByRole('button', { name: section, exact: true }).click()
      expect(await settings.getByRole('button', { name: 'General', exact: true }).boundingBox()).toEqual(settingsBounds)
      await assertPageAccessibility(page)
      expect(await settings.locator('[style]').evaluateAll(elements => elements.map(element => element.outerHTML))).toEqual([])
      await page.screenshot({ path: `.artifacts/finish/settings-${section.replaceAll(' ', '-')}-${colorScheme}.png` })
    }
    await settings.getByRole('button', { name: 'General', exact: true }).click()
    await settings.press('Tab')
    expect(await settings.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await settings.press('Shift+Tab')
    expect(await settings.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await settings.press('Escape')
    await settings.waitFor({ state: 'detached' })
    expect(await settingsTrigger.evaluate(element => element === document.activeElement)).toBe(true)
    await settingsTrigger.click()
    await page.setViewportSize({ width: 390, height: 844 })
    await assertPageAccessibility(page)
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: `.artifacts/finish/settings-mobile-${colorScheme}.png` })
    await settings.press('Escape')
    await settings.waitFor({ state: 'detached' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await action.getByRole('button', { name: /Agent Team/iu }).click()
  }, 60_000)

  it('assigns, completes, reopens, edits and deletes a task, then opens the peer conversation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-actions'))
    await page.setViewportSize({ width: 1680, height: 1000 })
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    const task = panel.getByRole('article', { name: 'Browser task', exact: true })
    await task.getByRole('combobox', { name: 'Owner' }).selectOption('lead')
    await task.getByText('In progress', { exact: true }).waitFor()
    await task.getByRole('button', { name: 'Complete', exact: true }).click()
    await task.getByText('Completed', { exact: true }).waitFor()
    expect(await task.getByRole('combobox', { name: 'Owner' }).isDisabled()).toBe(true)
    await task.getByRole('button', { name: 'Reopen', exact: true }).click()
    await task.getByText('Pending', { exact: true }).waitFor()
    expect(await task.getByRole('combobox', { name: 'Owner' }).inputValue()).toBe('')
    await task.getByRole('button', { name: 'Edit', exact: true }).click()
    const subject = panel.getByRole('textbox', { name: 'Task subject', exact: true })
    expect(await subject.evaluate(element => element === document.activeElement)).toBe(true)
    await subject.fill('Reviewed browser task')
    await subject.press('Enter')
    const edited = panel.getByRole('article', { name: 'Reviewed browser task', exact: true })
    await edited.waitFor()
    await assertPageAccessibility(page)
    await edited.getByRole('button', { name: 'Delete', exact: true }).click()
    await edited.waitFor({ state: 'detached' })
    await panel.getByRole('region', { name: 'Members', exact: true })
      .getByRole('button', { name: `session:team-reviewer-${colorScheme}`, exact: true }).click()
    await panel.waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['task.expected.md'])
  })
})
