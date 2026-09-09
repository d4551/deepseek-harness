import { expect, it, onTestFinished } from 'vitest'
import { launchSettingsSuite, readSettingsDocument } from '../settings-e2e-support.ts'

it('retains plugin drafts across keyboard flow disclosure and discards without changing saved settings', async () => {
  const { scaffold, browser, page, tripwire } = await launchSettingsSuite()
  onTestFinished(async () => {
    await browser.close()
    await scaffold.close()
  })

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
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
