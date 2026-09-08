// Keyless assembled-browser coverage for the Agent Teams panel the shipped Web
// bundle mounts, over the real Host Typert Remote flow.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, launchBrowser, newEnglishPage, saveFailureShot } from './support.ts'
import { assertPageAccessibility } from './accessibility.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/agent-team-panel', import.meta.url))
const PANEL_EXPECTED = join(SNAPSHOT_DIR, 'task.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Agent Teams panel', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    browser = await launchBrowser()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
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
    await action.getByText('No shared tasks yet').waitFor()
    await action.getByText('lead').waitFor()
    await assertPageAccessibility(page)

    await action.getByRole('button', { name: 'New task' }).click()
    await assertPageAccessibility(page)
    await action.getByPlaceholder('Task subject').fill('Browser task')
    await action.getByPlaceholder('Task description').fill('Created through the assembled browser')
    await action.getByPlaceholder(/Write scopes/iu).fill('src/web')
    await action.getByRole('button', { name: 'Save' }).click()
    await action.getByText('Browser task').waitFor()

    const snapshot = await captureStableAria(page, '[data-team-action]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(PANEL_EXPECTED, snapshot, MODE)
    const lead = scaffold.ctx.agents.list()[0]
    if (lead === undefined) throw new Error('Team lead is unavailable')
    const external = await scaffold.ctx.agentTeams.createTask(lead, {
      subject: 'Task created outside the panel',
      description: 'Live update from another Team client',
    })
    await action.getByText('Task created outside the panel', { exact: true }).waitFor()
    await scaffold.ctx.agentTeams.updateTask(lead, {
      taskId: external.id,
      expectedRevision: external.revision,
      action: 'edit',
      subject: 'Task updated outside the panel',
    })
    await action.getByText('Task updated outside the panel', { exact: true }).waitFor()
    await action.getByRole('button', { name: 'Close', exact: true }).click()
    await action.getByRole('button', { name: /Agent Team/iu }).click()
    await action.getByText('Task updated outside the panel', { exact: true }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
    await assertPageAccessibility(page)
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['task.expected.md'])
  })
})
