import { expect, it, onTestFinished } from 'vitest'
import { launchSettingsSuite, readSettingsDocument } from '../settings-e2e-support.ts'
import { connectFreshWorkspaceZh } from './support.ts'
import { assertPageAccessibility } from './accessibility.ts'

it('retains plugin drafts across keyboard flow disclosure and discards without changing saved settings', async () => {
  const { scaffold, browser, page, tripwire } = await launchSettingsSuite()
  onTestFinished(async () => {
    await browser.close()
    await scaffold.close()
  })

  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  const flow = dialog.getByRole('button', { name: '智能体与执行设置', exact: true })
  await flow.waitFor()
  expect(await flow.getAttribute('aria-expanded')).toBe('false')
  const saved = await readSettingsDocument(scaffold)

  await flow.press('Enter')
  expect(await flow.getAttribute('aria-expanded')).toBe('true')
  await dialog.getByRole('button', {
    name: '展开设置: Agent 循环', exact: true,
  }).click()
  const parallelism = dialog.getByLabel('并行工具调用数', { exact: true })
  const original = await parallelism.inputValue()
  const edited = original === '3' ? '4' : '3'
  await parallelism.fill(edited)
  await flow.press('Space')
  expect(await flow.getAttribute('aria-expanded')).toBe('false')
  expect(await parallelism.isVisible()).toBe(false)
  await flow.press('Enter')
  expect(await parallelism.inputValue()).toBe(edited)
  expect(await readSettingsDocument(scaffold)).toBe(saved)
  await dialog.getByRole('button', { name: '放弃修改', exact: true }).click()
  expect(await parallelism.inputValue()).toBe(original)
  expect(await readSettingsDocument(scaffold)).toBe(saved)
  await dialog.getByRole('button', { name: '收起设置: Agent 循环', exact: true }).click()
  await dialog.getByRole('button', { name: '展开设置: 智能体团队', exact: true }).click()
  const taskLimit = dialog.getByLabel('共享任务数', { exact: true })
  await taskLimit.fill('0')
  expect(await dialog.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
  await taskLimit.fill('1')
  await assertPageAccessibility(page)
  await page.screenshot({ path: '.artifacts/finish/settings-team-capacity.png' })
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => scaffold.ctx.settings.describe().find(entry => entry.ns === 'agent-team')?.value)
    .toMatchObject({ maxTasks: 1 })
  const lead = scaffold.ctx.agents.list()[0]
  if (lead === undefined) throw new Error('Settings workspace has no Team lead')
  await scaffold.ctx.agentTeams.createTask(lead, { subject: 'Capacity check', description: 'Saved browser setting' })
  await expect(scaffold.ctx.agentTeams.createTask(lead, { subject: 'Over capacity', description: 'Must be rejected' }))
    .rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
  expect(await readSettingsDocument(scaffold)).not.toBe(saved)
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  await flow.click()
  await dialog.getByRole('button', { name: '展开设置: 智能体团队', exact: true }).click()
  expect(await taskLimit.inputValue()).toBe('1')
  await assertPageAccessibility(page)

  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
