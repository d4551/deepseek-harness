import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, launchBrowser, newEnglishPage } from './support.ts'
import { assertPageAccessibility } from './accessibility.ts'

const themes: Array<'light' | 'dark'> = ['light', 'dark']

it.each(themes)('tracks agent-owned work and messages without manual task controls in %s', async (theme) => {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const browser = await launchBrowser()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => { errors.push(error.message) })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const lead = scaffold.ctx.agents.list()[0]
  if (lead === undefined) throw new Error('Workspace did not create a Team lead')
  lead.session.append('turn/start', { turn: 1 })
  lead.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Review the shared work.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  lead.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await scaffold.ctx.sessions.flush(lead.session)
  const trigger = page.locator('[data-team-action]').getByRole('button', { name: /Agent Team/u })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Agent Team', exact: true })
  await dialog.getByText('No shared tasks yet', { exact: true }).waitFor()
  await page.screenshot({ path: `.artifacts/finish/verified-team-empty-${theme}.png` })
  expect(await dialog.getByRole('textbox').count()).toBe(0)
  expect(await dialog.getByRole('combobox').count()).toBe(0)
  expect(await dialog.getByRole('button', { name: /New task|Manage this conversation/u }).count()).toBe(0)
  const panels = await dialog.getByRole('region').evaluateAll(elements => elements.map((element) => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
  }))
  expect(panels).toHaveLength(4)
  expect(panels[0]?.top).toBe(panels[3]?.top)
  expect(panels[1]?.top).toBeGreaterThan(panels[0]?.bottom ?? 0)
  expect(panels[2]?.top).toBeGreaterThan(panels[1]?.bottom ?? 0)
  expect(panels[0]?.left).toBe(panels[1]?.left)
  expect(panels[0]?.left).toBe(panels[2]?.left)
  expect(panels[3]?.left).toBeGreaterThan(panels[0]?.right ?? 0)
  const headings = await dialog.getByRole('heading', { level: 3 }).evaluateAll(elements =>
    elements.map(element => element.getBoundingClientRect().top))
  expect(headings[0]).toBe(headings[3])

  let call = 0
  const execute = async (agent: Agent, name: string, args: object): Promise<void> => {
    const result = await scaffold.ctx.tools.execute({
      agent, name, arguments: args, callId: ToolCallId(`team-journey-${++call}`), signal: new AbortController().signal,
    })
    expect(result.isError).not.toBe(true)
  }
  await execute(lead, 'team_task_create', {
    subject: 'Coordinate workspace review', description: 'Share review responsibilities between workspace conversations.',
    write_scopes: ['src/coordination'],
  })
  const created = scaffold.ctx.agentTeams.listTasks(lead)[0]
  if (created === undefined) throw new Error('Agent tool did not create a task')
  const task = dialog.getByRole('article', { name: created.subject, exact: true })
  await task.waitFor()
  await execute(lead, 'team_task_claim_next', {})
  await task.getByText('In progress', { exact: true }).waitFor()
  expect(await task.getByText('Owner: lead', { exact: true }).isVisible()).toBe(true)
  const claimed = scaffold.ctx.agentTeams.getTask(lead, created.id)
  await execute(lead, 'team_task_update', { task_id: claimed.id, expected_revision: claimed.revision, action: 'complete' })
  await task.getByText('Completed', { exact: true }).waitFor()
  await page.screenshot({ path: `.artifacts/finish/verified-team-agent-work-${theme}.png` })

  const workspace = scaffold.ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(lead.id))
  if (workspace === undefined) throw new Error('Team lead has no registered workspace')
  const peer = (await scaffold.ctx.agents.create({
    sessionId: SessionId(`visual-reviewer-${theme}`), meta: { cwd: workspace.path }, agentOptions: {},
  })).agent
  await workspace.attachSession(peer.id)
  await execute(peer, 'team_task_create', {
    subject: 'Review settings accessibility', description: 'Check focus containment and report to the originating conversation.',
    write_scopes: ['src/settings'],
  })
  const peerTask = scaffold.ctx.agentTeams.listTasks(peer)[0]
  if (peerTask === undefined) throw new Error('Peer tool did not create a task')
  const peerWork = dialog.getByRole('article', { name: peerTask.subject, exact: true })
  await peerWork.waitFor()
  const guidance = renderPrompt(await scaffold.ctx.systemPrompt.assemble(assembleContextFor(lead)))
  expect(guidance).toContain(JSON.stringify({ sessionId: peer.id, tasks: [peerTask] }))
  expect(guidance).toContain('Do not ask the user to copy task ids, assign owners, or enter file scopes')
  expect(await peerWork.getByRole('combobox').count()).toBe(0)
  expect(await peerWork.getByRole('button').count()).toBe(0)
  const target = scaffold.ctx.agentTeams.listMembers(lead).find(member => member.id === peer.id)
  const sender = scaffold.ctx.agentTeams.listMembers(peer).find(member => member.id === lead.id)
  if (target === undefined || sender === undefined) throw new Error('Registered peers are not discoverable')
  await execute(lead, 'send_message', { target: target.name, message: 'Review the task.\nCheck keyboard navigation.' })
  await execute(peer, 'send_message', { target: sender.name, message: 'Review complete. Focus stays inside Settings.' })
  const messages = dialog.getByRole('region', { name: 'Messages between members' })
  expect(await messages.getByRole('table', { name: 'Messages between members' }).getByRole('row').count()).toBe(2)
  const thread = messages.getByRole('button', { name: 'Untitled conversation ↔ lead', exact: true })
  await thread.click()
  await messages.getByText('Review complete. Focus stays inside Settings.', { exact: true }).waitFor()
  await expect.poll(() => messages.getByText('Delivered', { exact: true }).count()).toBe(1)
  await messages.getByRole('button', { name: 'Older message', exact: true }).click()
  expect(await messages.innerText()).toContain('Review the task.\nCheck keyboard navigation.')
  expect(await messages.getByText('Delivered', { exact: true }).count()).toBe(1)
  await messages.getByRole('button', { name: 'Newer message', exact: true }).click()
  await page.screenshot({ caret: 'initial', path: `.artifacts/finish/verified-team-messages-${theme}.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await dialog.getByRole('textbox', { name: 'Search message text', exact: true }).count()).toBe(1)
  await page.screenshot({ caret: 'initial', path: `.artifacts/finish/verified-team-messages-mobile-${theme}.png` })
  expect(await dialog.locator('[style]').count()).toBe(0)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.setViewportSize({ width: 1680, height: 1000 })
  await trigger.click()
  await thread.click()
  await messages.getByText('Review complete. Focus stays inside Settings.', { exact: true }).waitFor()
  expect(errors).toEqual([])
  await assertPageAccessibility(page)
})
