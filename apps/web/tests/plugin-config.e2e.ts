// Web e2e scenario: the configurable tab in Plugins settings — the cards a
// deployment's exposed host-plane namespaces produce, one field edited through the real
// wire down to `$DSH_HOME/settings.yaml`, and the override badge and reset
// that layering produces. Zero model calls: everything is client state plus
// the settings document on a blank frame, so there is no fixture and a stray
// stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/plugin-config', import.meta.url))
const SECTION_EXPECTED = join(SNAPSHOT_DIR, 'section.expected.md')
const AGENT_TEAM_PATCH = fileURLToPath(
  new URL('../../../packages/preset/agent-team-profile/cordis.patch.yml', import.meta.url),
)
const AGENT_TEAM_INSTALL_ANCHOR = fileURLToPath(
  new URL('../../../packages/preset/agent-team-profile/package.json', import.meta.url),
)
const MODE = webSnapshotMode()

/** Open the Plugins section of the settings dialog on one scaffold page. */
async function openPlugins(page: Page) {
  if (await page.getByRole('dialog', { name: '设置' }).count() > 0) {
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  await expect
    .poll(() => dialog.getByRole('button', { name: '插件', exact: true }).getAttribute('aria-current'), { timeout: 5_000 })
    .toBe('true')
  await expect
    .poll(() => dialog.getByRole('tab', { name: '插件配置', exact: true }).getAttribute('aria-selected'), { timeout: 5_000 })
    .toBe('true')
  return dialog
}

/** Read the settings document written by one isolated Host. */
async function settingsDocument(scaffold: WebScaffold): Promise<string> {
  return readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8').catch(() => '')
}

describe('web e2e: plugin configuration section', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // Chinese browser: the section asserts the localized copy the client
    // derives from it, as the rest of the settings surface does.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows one card per exposed host-plane namespace', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-cards'))
    const dialog = await openPlugins(page)

    // Every card the shipped web composition exposes: the shell executor, the
    // agent loop, the two approval guards, subagent selection, and the DeepSeek
    // search provider.
    await dialog.getByText('Subagent', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('button', { name: '展开设置: Subagent' }).count()).toBe(1)
    await dialog.getByText('终端', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByText('Agent 循环', { exact: true }).count()).toBe(1)
    const approvalAssessor = dialog.getByRole('button', { name: '展开设置: 审批审计' })
    await approvalAssessor.waitFor({ timeout: 10_000 })
    expect(await approvalAssessor.count()).toBe(1)
    // The adversary ships mounted but off; its card renders because the base
    // serves the namespace, and enabling it is this page's job.
    const approvalAdversary = dialog.getByRole('button', { name: '展开设置: 对抗式审批评审' })
    await approvalAdversary.waitFor({ timeout: 10_000 })
    expect(await approvalAdversary.count()).toBe(1)
    expect(await dialog.getByRole('button', { name: '展开设置: 智能体团队' }).count()).toBe(0)
    expect(await dialog.getByText('DeepSeek 搜索', { exact: true }).count()).toBe(1)
    // Collapsed: a card's fields appear only once it is expanded.
    expect(await dialog.getByLabel('命令超时（毫秒）').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SECTION_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('persists selected adapter routes as the subagent model allowlist', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-subagent-model-selection'))
    const dialog = await openPlugins(page)
    await dialog.getByText('Subagent', { exact: true }).click()
    const toggle = dialog.getByRole('switch', { name: '允许 Agent 为 Subagent 选择模型' })

    await toggle.click()
    const models = dialog.getByRole('group', { name: 'Agent 可选择的模型' })
    await models.waitFor({ timeout: 10_000 })
    const firstModel = models.getByRole('checkbox').first()
    await firstModel.check()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()

    const expandSubagent = dialog.getByRole('button', { name: '展开设置: Subagent' })
    await expandSubagent.waitFor({ timeout: 5_000 })
    await expect.poll(async () => (await settingsDocument(scaffold)).includes('subagent-model-selection:'), { timeout: 10_000 })
      .toBe(true)
    expect(await settingsDocument(scaffold)).toContain('enabled: true')
    expect(await settingsDocument(scaffold)).toContain('allowedModels:')
    expect(await settingsDocument(scaffold)).toContain('provider:')
    expect(await settingsDocument(scaffold)).toContain('model:')
    await expandSubagent.click()
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('true')
    await expect.poll(() => dialog.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
    expect(await dialog.getByText('未保存', { exact: true }).count()).toBe(0)

    await toggle.click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expandSubagent.waitFor({ timeout: 5_000 })
    await expect.poll(async () => (await settingsDocument(scaffold)).includes('enabled: false'), { timeout: 10_000 })
      .toBe(true)
    expect(await settingsDocument(scaffold)).toContain('allowedModels:')
    expect(await settingsDocument(scaffold)).toContain('provider:')
    expect(await settingsDocument(scaffold)).toContain('model:')
    await expandSubagent.click()
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 5_000 }).toBe('false')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stages an edit and writes it only when saved', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-write'))
    const dialog = await openPlugins(page)
    await dialog.getByText('终端', { exact: true }).click()

    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })
    // The composed default this deployment ships, before any user layer.
    expect(await timeout.inputValue()).toBe('60000')
    await timeout.fill('12000')
    await timeout.blur()

    // Nothing crosses the wire until the user saves: leaving the control is
    // not a decision to store the value.
    expect(await settingsDocument(scaffold)).not.toContain('timeoutMs')
    const save = dialog.getByRole('button', { name: '保存', exact: true })
    await expect.poll(() => save.isEnabled(), { timeout: 5_000 }).toBe(true)
    await save.click()

    await expect.poll(async () => (await settingsDocument(scaffold)).includes('timeoutMs: 12000'), { timeout: 10_000 })
      .toBe(true)
    const expandTerminal = dialog.getByRole('button', { name: '展开设置: 终端' })
    await expandTerminal.waitFor({ timeout: 5_000 })
    await expandTerminal.click()
    // Presence in the user layer is what the badge reports, and the reset is
    // offered only for a field that has one.
    await expect.poll(() => dialog.getByText('已覆盖').count(), { timeout: 5_000 }).toBe(1)
    expect(await dialog.getByRole('button', { name: '恢复默认' }).count()).toBe(1)
    // A settled form offers no save to repeat.
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('drops a staged edit on discard without touching the document', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-discard'))
    const dialog = await openPlugins(page)
    await dialog.getByText('终端', { exact: true }).click()
    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('7000')
    await dialog.getByRole('button', { name: '放弃修改' }).click()

    await expect.poll(() => timeout.inputValue(), { timeout: 5_000 }).toBe('12000')
    expect(await settingsDocument(scaffold)).toContain('timeoutMs: 12000')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('refuses to save a draft that is not a number', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-invalid'))
    const dialog = await openPlugins(page)
    await dialog.getByText('终端', { exact: true }).click()
    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })

    await timeout.fill('soon')

    const save = dialog.getByRole('button', { name: '保存', exact: true })
    await expect.poll(() => save.isDisabled(), { timeout: 5_000 }).toBe(true)
    expect(await dialog.getByText('请填数字；留空表示使用默认值。').count()).toBe(1)
    await dialog.getByRole('button', { name: '放弃修改' }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('clears the field back to the composed default on reset', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-reset'))
    const dialog = await openPlugins(page)
    await dialog.getByText('终端', { exact: true }).click()
    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })
    expect(await timeout.inputValue()).toBe('12000')

    // The reset stages the composed default; the document still carries the
    // override until the save lands.
    await dialog.getByRole('button', { name: '恢复默认' }).click()
    await expect.poll(() => timeout.inputValue(), { timeout: 5_000 }).toBe('60000')
    expect(await settingsDocument(scaffold)).toContain('timeoutMs: 12000')

    await dialog.getByRole('button', { name: '保存', exact: true }).click()

    await expect.poll(async () => (await settingsDocument(scaffold)).includes('timeoutMs'), { timeout: 10_000 })
      .toBe(false)
    const expandTerminal = dialog.getByRole('button', { name: '展开设置: 终端' })
    await expandTerminal.waitFor({ timeout: 5_000 })
    await expandTerminal.click()
    expect(await timeout.inputValue()).toBe('60000')
    expect(await dialog.getByText('已覆盖').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('commits the review route as a pair and refuses half of one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-approval-adversary'))
    const dialog = await openPlugins(page)
    const expand = dialog.getByRole('button', { name: '展开设置: 对抗式审批评审' })
    await expand.waitFor({ timeout: 10_000 })
    await expand.click()
    const provider = dialog.getByRole('textbox', { name: '评审提供方', exact: true })
    const model = dialog.getByRole('textbox', { name: '评审模型', exact: true })
    const save = dialog.getByRole('button', { name: '保存', exact: true })
    expect(await provider.inputValue()).toBe('')
    expect(await model.inputValue()).toBe('')

    // The Host refuses half a route and the card keeps the draft for correction.
    await provider.fill('reviewer-route')
    await expect.poll(() => save.isEnabled(), { timeout: 5_000 }).toBe(true)
    await save.click()
    await dialog.getByText('本部署没有接受这些值，已保留供你修改。', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await settingsDocument(scaffold)).not.toContain('reviewer-route')

    // The complete pair lands in one mutation.
    await model.fill('reviewer-model')
    await save.click()
    await expand.waitFor({ timeout: 10_000 })
    await expect.poll(async () => await settingsDocument(scaffold), { timeout: 10_000 })
      .toContain('provider: reviewer-route')
    expect(await settingsDocument(scaffold)).toContain('model: reviewer-model')

    // Clearing both returns the review to the agent's own route.
    await expand.click()
    expect(await provider.inputValue()).toBe('reviewer-route')
    expect(await model.inputValue()).toBe('reviewer-model')
    const resets = dialog.getByRole('button', { name: '恢复默认', exact: true })
    expect(await resets.count()).toBe(2)
    await resets.nth(1).click()
    await resets.nth(0).click()
    await save.click()
    await expand.waitFor({ timeout: 10_000 })
    await expect.poll(async () => await settingsDocument(scaffold), { timeout: 10_000 })
      .not.toContain('reviewer-route')
    expect(await settingsDocument(scaffold)).not.toContain('reviewer-model')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['section.expected.md'])
  })
})

describe('web e2e: Agent Team plugin configuration', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: AGENT_TEAM_PATCH,
      extraInstallAnchors: [AGENT_TEAM_INSTALL_ANCHOR],
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('rejects zero, persists both capacities, and resets them to the composed defaults', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-config-agent-team'))
    const dialog = await openPlugins(page)
    const expand = dialog.getByRole('button', { name: '展开设置: 智能体团队' })
    await expand.waitFor({ timeout: 10_000 })
    expect(await expand.count()).toBe(1)
    await expand.click()

    const members = dialog.getByRole('textbox', { name: '队友数量', exact: true })
    const tasks = dialog.getByRole('textbox', { name: '共享任务数', exact: true })
    expect(await members.inputValue()).toBe('8')
    expect(await tasks.inputValue()).toBe('256')

    await members.fill('0')
    const save = dialog.getByRole('button', { name: '保存', exact: true })
    await expect.poll(() => save.isEnabled(), { timeout: 5_000 }).toBe(true)
    await save.click()
    await dialog.getByText('本部署没有接受这些值，已保留供你修改。', { exact: true })
      .waitFor({ timeout: 10_000 })
    expect(await settingsDocument(scaffold)).not.toContain('maxMembers: 0')

    await members.fill('12')
    await tasks.fill('300')
    await save.click()
    await dialog.getByRole('button', { name: '展开设置: 智能体团队' }).waitFor({ timeout: 10_000 })
    await expect.poll(async () => await settingsDocument(scaffold), { timeout: 10_000 })
      .toContain('maxMembers: 12')
    expect(await settingsDocument(scaffold)).toContain('maxTasks: 300')

    await dialog.getByRole('button', { name: '展开设置: 智能体团队' }).click()
    expect(await members.inputValue()).toBe('12')
    expect(await tasks.inputValue()).toBe('300')
    expect(await dialog.getByText('已覆盖', { exact: true }).count()).toBe(2)
    const resets = dialog.getByRole('button', { name: '恢复默认', exact: true })
    expect(await resets.count()).toBe(2)
    await resets.nth(1).click()
    await resets.nth(0).click()
    expect(await members.inputValue()).toBe('8')
    expect(await tasks.inputValue()).toBe('256')
    await save.click()

    await dialog.getByRole('button', { name: '展开设置: 智能体团队' }).waitFor({ timeout: 10_000 })
    await expect.poll(async () => await settingsDocument(scaffold), { timeout: 10_000 })
      .not.toContain('maxMembers:')
    expect(await settingsDocument(scaffold)).not.toContain('maxTasks:')
    await dialog.getByRole('button', { name: '展开设置: 智能体团队' }).click()
    expect(await members.inputValue()).toBe('8')
    expect(await tasks.inputValue()).toBe('256')
    expect(await dialog.getByText('已覆盖', { exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)
})
