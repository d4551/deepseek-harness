import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { REQUEST_BUDGET_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { launchSettingsSuite, readSettingsDocument } from '../settings-e2e-support.ts'
import { assertPageAccessibility } from './accessibility.ts'
import { connectFreshWorkspaceZh } from './support.ts'

it('does not offer request limits when the real host has no budget policy', async () => {
  const { scaffold, browser, page, tripwire } = await launchSettingsSuite()
  onTestFinished(async () => {
    await browser.close()
    await scaffold.close()
  })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  await dialog.getByRole('button', { name: '智能体与执行设置', exact: true }).click()
  expect(scaffold.ctx.settings.describe().map(entry => String(entry.ns)))
    .not.toContain(REQUEST_BUDGET_SETTINGS_NAMESPACE)
  expect(await dialog.getByRole('button', { name: '展开设置: 模型请求预算', exact: true }).count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it('discovers request limits and saves, rejects, discards, reloads, and resets through the real host', async () => {
  const policy = { policyId: 'browser/request-budget', maxAgentAttempts: 7, maxRootAttempts: 23 }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-request-budget-settings-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const overlay = join(directory, 'cordis.patch.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'agent-loop', config: { agents: [], requestBudget: policy } },
  ]))
  const { scaffold, browser, page, tripwire } = await launchSettingsSuite({ extraOverlayPath: overlay })
  let completed = false
  onTestFinished(async () => {
    if (!completed) {
      await page.screenshot({ path: '.artifacts/finish/request-budget-settings-failure.png', fullPage: true })
      console.error(await page.locator('body').ariaSnapshot())
      console.error(tripwire)
    }
    await browser.close()
    await scaffold.close()
  })
  await expect.poll(() => scaffold.ctx.settings.describe().map(entry => String(entry.ns)))
    .toContain(REQUEST_BUDGET_SETTINGS_NAMESPACE)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  const flow = dialog.getByRole('button', { name: '智能体与执行设置', exact: true })
  await flow.click()
  const disclosure = dialog.getByRole('button', { name: '展开设置: 模型请求预算', exact: true })
  await disclosure.click()
  const task = dialog.getByRole('textbox', { name: '整个任务的请求数', exact: true })
  const agent = dialog.getByRole('textbox', { name: '每个委派智能体的请求数', exact: true })
  const save = dialog.getByRole('button', { name: '保存', exact: true })
  const discard = dialog.getByRole('button', { name: '放弃修改', exact: true })
  expect(await task.inputValue()).toBe(String(policy.maxRootAttempts))
  expect(await agent.inputValue()).toBe(String(policy.maxAgentAttempts))
  expect(await dialog.getByText('限制在下一次模型请求时生效，并计入已使用的请求。保存会保留当前计数，不会恢复已暂停的工作。发送后续消息以授权继续工作。', { exact: true }).count()).toBe(1)
  const before = await readSettingsDocument(scaffold)

  for (const invalid of ['0', '-1', '1.5', 'word', 'Infinity', '9007199254740992']) {
    await agent.fill(invalid)
    expect(await agent.getAttribute('aria-invalid')).toBe('true')
    expect(await save.isDisabled()).toBe(true)
    expect(await readSettingsDocument(scaffold)).toBe(before)
  }
  await discard.click()
  expect(await agent.inputValue()).toBe(String(policy.maxAgentAttempts))
  expect(await save.isDisabled()).toBe(true)

  await agent.fill('24')
  await save.click()
  await dialog.getByRole('status').filter({
    hasText: '本部署没有接受这些值，已保留供你修改。',
  }).waitFor()
  expect(await agent.inputValue()).toBe('24')
  expect(await readSettingsDocument(scaffold)).toBe(before)
  expect(scaffold.ctx.requestBudgetPolicy.get()).toEqual(policy)

  await task.fill('48')
  await assertPageAccessibility(page)
  await save.click()
  await expect.poll(() => scaffold.ctx.requestBudgetPolicy.get()).toEqual({
    ...policy, maxAgentAttempts: 24, maxRootAttempts: 48,
  })
  await disclosure.waitFor()
  expect(await disclosure.getAttribute('aria-expanded')).toBe('false')
  await page.reload({ waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  await flow.click()
  await disclosure.click()
  expect(await task.inputValue()).toBe('48')
  expect(await agent.inputValue()).toBe('24')

  const saved = await readSettingsDocument(scaffold)
  await dialog.getByRole('button', { name: '恢复默认', exact: true }).first().click()
  expect(await task.inputValue()).toBe(String(policy.maxRootAttempts))
  await dialog.getByRole('button', { name: '恢复默认', exact: true }).click()
  expect(await agent.inputValue()).toBe(String(policy.maxAgentAttempts))
  expect(await readSettingsDocument(scaffold)).toBe(saved)
  await save.click()
  await expect.poll(() => scaffold.ctx.requestBudgetPolicy.get()).toEqual(policy)
  await disclosure.click()
  expect(scaffold.ctx.settings.describe().find(entry => entry.ns === REQUEST_BUDGET_SETTINGS_NAMESPACE)?.user)
    .toEqual({})
  await assertPageAccessibility(page)
  await save.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '.artifacts/finish/request-budget-settings-zh.png' })

  await dialog.getByRole('button', { name: '通用设置', exact: true }).click()
  await dialog.getByRole('button', { name: '中文', exact: true }).click()
  await page.getByRole('menuitem', { name: 'English', exact: true }).click()
  const english = page.getByRole('dialog', { name: 'Settings' })
  await english.getByRole('button', { name: 'Plugins', exact: true }).click()
  await english.getByRole('button', { name: 'Agent and execution settings', exact: true }).click()
  await english.getByRole('button', { name: 'Show settings: Model request budget', exact: true }).click()
  await english.getByRole('textbox', { name: 'Requests for the whole task', exact: true }).waitFor()
  expect(await english.getByRole('textbox', { name: 'Requests per delegated agent', exact: true }).inputValue())
    .toBe(String(policy.maxAgentAttempts))
  await assertPageAccessibility(page)
  await english.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '.artifacts/finish/request-budget-settings-en.png' })
  const entry = [...scaffold.ctx.loader.entries()].find(row => row.options.id === 'agent-loop')
  if (entry?.fiber === undefined) throw new Error('Budget settings have no owning AgentLoop fiber')
  await entry.fiber.dispose()
  await expect.poll(() => scaffold.ctx.settings.describe().map(row => String(row.ns)))
    .not.toContain(REQUEST_BUDGET_SETTINGS_NAMESPACE)
  await expect.poll(() => english.getByRole('textbox', { name: 'Requests for the whole task', exact: true }).count())
    .toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
  completed = true
})
