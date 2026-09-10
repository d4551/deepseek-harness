import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, launchBrowser, newEnglishPage } from './support.ts'
import { assertPageAccessibility } from './accessibility.ts'

const themes: Array<'light' | 'dark'> = ['light', 'dark']

it.each(themes)('exercises Team messages and task transitions in %s', async (theme) => {
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
  await dialog.getByRole('button', { name: 'New task', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Task subject', exact: true }).fill('Review keyboard navigation')
  await dialog.getByRole('textbox', { name: 'Task description', exact: true }).fill('Verify focus, menus, and Settings persistence.')
  await dialog.getByRole('textbox', { name: 'Task subject', exact: true }).press('Enter')
  const task = dialog.getByRole('article', { name: 'Review keyboard navigation', exact: true })
  await task.getByRole('combobox', { name: 'Owner' }).selectOption('lead')
  await task.getByText('In progress', { exact: true }).waitFor()
  await task.getByRole('button', { name: 'Complete', exact: true }).click()
  await task.getByText('Completed', { exact: true }).waitFor()
  await task.getByRole('button', { name: 'Reopen', exact: true }).click()
  await task.getByText('Pending', { exact: true }).waitFor()

  const workspace = scaffold.ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(lead.id))
  if (workspace === undefined) throw new Error('Team lead has no registered workspace')
  const peer = (await scaffold.ctx.agents.create({
    sessionId: SessionId(`visual-reviewer-${theme}`), meta: { cwd: workspace.path }, agentOptions: {},
  })).agent
  await workspace.attachSession(peer.id)
  const target = scaffold.ctx.agentTeams.listMembers(lead).find(member => member.id === peer.id)
  const sender = scaffold.ctx.agentTeams.listMembers(peer).find(member => member.id === lead.id)
  if (target === undefined || sender === undefined) throw new Error('Registered peers are not discoverable')
  const signal = new AbortController().signal
  await scaffold.ctx.agentTeams.sendMessage(lead, {
    target: target.name, content: [{ type: 'text', text: 'Review the task.\nCheck keyboard navigation.' }], delivery: 'quiet', signal,
  })
  await scaffold.ctx.agentTeams.sendMessage(peer, {
    target: sender.name, content: [{ type: 'text', text: 'Review complete. Focus stays inside Settings.' }], delivery: 'quiet', signal,
  })
  const messages = dialog.getByRole('log', { name: 'Messages between members' })
  await messages.getByText('Review complete. Focus stays inside Settings.', { exact: true }).waitFor()
  await expect.poll(() => messages.getByText('Delivered', { exact: true }).count()).toBe(2)
  expect(await messages.innerText()).toContain('Review the task.\nCheck keyboard navigation.')
  await page.screenshot({ path: `.artifacts/finish/verified-team-messages-${theme}.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: `.artifacts/finish/verified-team-messages-mobile-${theme}.png` })
  await task.getByRole('button', { name: 'Edit', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Task subject', exact: true }).fill('Keyboard review complete')
  await dialog.getByRole('textbox', { name: 'Task subject', exact: true }).press('Enter')
  const edited = dialog.getByRole('article', { name: 'Keyboard review complete', exact: true })
  await edited.getByRole('button', { name: 'Delete', exact: true }).click()
  await edited.waitFor({ state: 'detached' })
  expect(await dialog.locator('[style]').evaluateAll(elements => elements.every(element => element.getAttribute('style') === ''))).toBe(true)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.setViewportSize({ width: 1680, height: 1000 })
  await trigger.click()
  await messages.getByText('Review complete. Focus stays inside Settings.', { exact: true }).waitFor()
  expect(errors).toEqual([])
  await assertPageAccessibility(page)
})
