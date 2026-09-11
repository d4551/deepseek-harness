// Keyless assembled-browser coverage for the Agent Teams panel the shipped Web
// bundle mounts, over the real Host Typert Remote flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { createMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
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
  let toolCall = 0

  async function execute(name: string, args: object): Promise<void> {
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Team lead is unavailable')
    const result = await scaffold.ctx.tools.execute({
      agent, name, arguments: args, callId: ToolCallId(`panel-${++toolCall}`),
      signal: new AbortController().signal,
    })
    expect(result.isError).not.toBe(true)
  }

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

  beforeEach(async () => {
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/iu }).click()
  })

  afterEach(async () => {
    await page.keyboard.press('Escape')
  })

  it('loads the roster and contains keyboard focus', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    await panel.getByText('No shared tasks yet').waitFor()
    await panel.getByText('lead', { exact: true }).waitFor()
    const close = panel.getByRole('button', { name: 'Close', exact: true })
    const refresh = panel.getByRole('button', { name: 'Refresh Team', exact: true })
    await close.focus()
    await close.press('Shift+Tab')
    expect(await refresh.evaluate(button => document.activeElement === button)).toBe(true)
    await refresh.press('Tab')
    expect(await close.evaluate(button => document.activeElement === button)).toBe(true)
  })

  it('passes accessibility checks with an empty team', async () => {
    await assertPageAccessibility(page)
  })

  it('keeps long peer identities readable with shared typography and aligned navigation', async () => {
    const lead = scaffold.ctx.agents.list()[0]
    if (lead === undefined) throw new Error('Team lead is unavailable')
    const workspace = scaffold.ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(lead.id))
    if (workspace === undefined) throw new Error('Team workspace is unavailable')
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId(`session-d1fe04f5-0374-4c4e-b448-6be7ceef04ef-${colorScheme}`),
      meta: { cwd: workspace.path }, agentOptions: { model: 'TheGreatBao' },
    })
    onTestFinished(async () => {
      await workspace.detachSession(handle.agent.id)
      await handle.dispose()
    })
    await workspace.attachSession(handle.agent.id)
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    const members = panel.getByRole('region', { name: 'Members', exact: true })
    await members.getByText('Untitled conversation', { exact: true }).waitFor()
    scaffold.ctx.sessionTitle.rename(handle.agent.session, 'Review Settings accessibility')
    const title = members.getByText('Review Settings accessibility', { exact: true })
    await title.waitFor()
    const memberTypography = await title.evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight]
    })
    const row = members.getByRole('article').filter({ has: page.getByText('Review Settings accessibility', { exact: true }) })
    const metadataTypography = await row.locator('.dsw-settings-cell-desc').evaluateAll(elements => elements.map((element) => {
      const style = getComputedStyle(element)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight]
    }))
    expect(metadataTypography).toHaveLength(2)
    for (const typography of metadataTypography) {
      expect(typography).toEqual([memberTypography[0], '12px', '400', '18px'])
    }
    for (const viewport of [{ width: 1680, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await row.scrollIntoViewIfNeeded()
      const titleBox = await title.boundingBox()
      const actionBox = await row.getByRole('button').boundingBox()
      if (titleBox === null || actionBox === null) throw new Error('Member controls are not visible')
      expect(actionBox.x).toBeGreaterThan(titleBox.x + titleBox.width)
      expect(Math.abs(actionBox.y - titleBox.y)).toBeLessThan(actionBox.height)
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const typography = await title.evaluate((element) => {
        const style = getComputedStyle(element)
        return [style.fontSize, style.fontWeight, style.lineHeight]
      })
      expect(typography).toEqual(['14px', '400', '21px'])
      await page.screenshot({ path: `.artifacts/finish/team-member-${colorScheme}-${viewport.width}.png` })
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    await panel.press('Escape')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    const settingsTypography = await settings.locator('.dsw-settings-cell-title').first().evaluate((element) => {
      const style = getComputedStyle(element)
      return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight]
    })
    expect(memberTypography).toEqual(settingsTypography)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('follows agent-owned tasks and messages through generated Remote', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-panel'))
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    for (const viewport of [{ width: 840, height: 1000 }, { width: 600, height: 480 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(async () => {
        const bounds = await panel.boundingBox()
        return bounds !== null && bounds.x >= 0 && bounds.y >= 0
          && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height
      }).toBe(true)
    }
    await page.setViewportSize({ width: 1680, height: 1000 })

    expect(await panel.getByRole('textbox').count()).toBe(0)
    expect(await panel.getByRole('combobox').count()).toBe(0)
    await execute('team_task_create', {
      subject: 'Browser task', description: 'Created by the agent through Team tools', write_scopes: ['src/web'],
    })
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
    const messages = panel.getByRole('region', { name: 'Messages between members' })
    expect(await messages.getByRole('table', { name: 'Messages between members' }).getByRole('row').count()).toBe(2)
    await messages.getByRole('button', { name: 'Untitled conversation ↔ lead', exact: true }).click()
    await messages.getByText('Review complete. Keyboard navigation works.', { exact: true }).waitFor()
    await expect.poll(() => messages.getByText('Delivered', { exact: true }).count()).toBe(1)
    expect(await messages.getByText('Queued', { exact: true }).count()).toBe(0)
    expect(await messages.innerText()).toContain('Untitled conversation → lead')
    await messages.getByRole('button', { name: 'Older message', exact: true }).click()
    expect(await messages.innerText()).toContain('Please review the task changes.\nCheck keyboard navigation too.')
    expect(await messages.getByText('Delivered', { exact: true }).count()).toBe(1)
    await assertPageAccessibility(page)
  }, 60_000)

  it('retains team state when reopened and passes accessibility checks', async () => {
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    const action = page.locator('[data-team-action]')
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
    await action.getByRole('button', { name: /Agent Team/iu }).click()
    await panel.getByText('Task updated outside the panel', { exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
    await assertPageAccessibility(page)
    expect(tripwire.warnings).toEqual([])
    await page.screenshot({ caret: 'initial', path: `.artifacts/finish/team-tasks-${colorScheme}.png` })
  })

  it('fits the mobile viewport and passes accessibility checks', async () => {
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ caret: 'initial', path: `.artifacts/finish/team-tasks-mobile-${colorScheme}.png` })
    await assertPageAccessibility(page)
  })

  it('shares navigation, typography and responsive controls with Settings', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    const close = panel.getByRole('button', { name: 'Close', exact: true })
    const conversations = panel.getByRole('region', { name: 'Subagent conversations', exact: true })
    await conversations.scrollIntoViewIfNeeded()
    const headingBounds = await conversations.getByRole('heading').boundingBox()
    if (headingBounds === null) throw new Error('Conversation heading is not visible')
    expect(headingBounds.x).toBeGreaterThanOrEqual(0)
    expect(headingBounds.x + headingBounds.width).toBeLessThanOrEqual(390)
    expect(await conversations.getByRole('button', { name: 'Refresh conversations' }).count()).toBe(0)
    await page.screenshot({ caret: 'initial', path: `.artifacts/finish/team-tasks-mobile-controls-${colorScheme}.png` })
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
  }, 60_000)

  it('contains Settings keyboard focus and fits mobile screens', async () => {
    await page.getByRole('dialog', { name: 'Agent Team' }).getByRole('button', { name: 'Close', exact: true }).click()
    const settingsTrigger = page.getByRole('button', { name: 'Settings', exact: true })
    await settingsTrigger.click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
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
  }, 60_000)

  it('observes agent assignment, completion, reopening and editing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-team-actions'))
    await page.setViewportSize({ width: 1680, height: 1000 })
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    const task = panel.getByRole('article', { name: 'Browser task', exact: true })
    const lead = scaffold.ctx.agents.list()[0]
    if (lead === undefined) throw new Error('Team lead is unavailable')
    const created = scaffold.ctx.agentTeams.listTasks(lead).find(entry => entry.subject === 'Browser task')
    if (created === undefined) throw new Error('Browser task is unavailable')
    const update = async (action: string, fields: object = {}): Promise<void> => {
      const current = scaffold.ctx.agentTeams.getTask(lead, created.id)
      await execute('team_task_update', { task_id: current.id, expected_revision: current.revision, action, ...fields })
    }
    await update('reassign', { owner: 'lead' })
    await task.getByText('In progress', { exact: true }).waitFor()
    await update('complete')
    await task.getByText('Completed', { exact: true }).waitFor()
    expect(await task.getByRole('combobox').count()).toBe(0)
    await update('reopen')
    await task.getByText('Pending', { exact: true }).waitFor()
    expect(await task.getByText('Owner: Unowned', { exact: true }).isVisible()).toBe(true)
    await update('edit', { subject: 'Reviewed browser task' })
    const edited = panel.getByRole('article', { name: 'Reviewed browser task', exact: true })
    await edited.waitFor()
    await assertPageAccessibility(page)
  }, 60_000)

  it('observes deletion and opens the peer conversation', async () => {
    const panel = page.getByRole('dialog', { name: 'Agent Team' })
    const edited = panel.getByRole('article', { name: 'Reviewed browser task', exact: true })
    const lead = scaffold.ctx.agents.list()[0]
    if (lead === undefined) throw new Error('Team lead is unavailable')
    const current = scaffold.ctx.agentTeams.listTasks(lead).find(entry => entry.subject === 'Reviewed browser task')
    if (current === undefined) throw new Error('Reviewed browser task is unavailable')
    await execute('team_task_update', {
      task_id: current.id, expected_revision: current.revision, action: 'delete',
    })
    await edited.waitFor({ state: 'detached' })
    await panel.getByRole('region', { name: 'Members', exact: true })
      .getByRole('button', { name: 'Open member conversation: Untitled conversation', exact: true }).click()
    await panel.waitFor({ state: 'detached' })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

})

it.skipIf(MODE === 'record')('keeps the Agent Team fixture inventory closed', async () => {
  await assertFixtureInventory(SNAPSHOT_DIR, ['task.expected.md'])
})
