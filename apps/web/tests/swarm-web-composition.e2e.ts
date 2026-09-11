// Real swarm-web composition, browser command submission, and durable queue.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { composeEntries, loadProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
// Empty type imports carry the agents/subagents/agentTeams/systemPrompt/clientModules Context merges.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, launchBrowser, newEnglishPage, REPO_ROOT } from './support.ts'

/** The profile with expanded swarm capacity. */
const TEMPLATE_NAME = 'swarm-web'

/** The scaffold's shipped base and browser layers. */
const SCAFFOLD_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Client packages the roster must serve for the swarm surface to be usable. */
const REQUIRED_CLIENT_ROWS = [
  '@deepseek-ai/dsh-client-ui-agent-team',
  '@deepseek-ai/dsh-client-ui-workspace-roots',
]

function expectConfig(rows: readonly EntryOptions[], id: string, config: object): void {
  const row = rows.find(entry => entry.id === id)
  expect(row, `the composed ${TEMPLATE_NAME} tree must carry row ${id}`).toBeDefined()
  expect(row?.config).toMatchObject(config)
}

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('composes the shipped swarm-web template into the swarm bounds and browser rows', async () => {
  const template = PROFILE_TEMPLATES[TEMPLATE_NAME]
  expect(template, 'swarm-web must remain a shipped profile template').toBeDefined()
  expect(template?.patchReload).toBe('live')
  const bundles = [...template?.bundles ?? []]
  expect(bundles.slice(0, SCAFFOLD_BUNDLES.length)).toEqual(SCAFFOLD_BUNDLES)
  expect(bundles.length).toBeGreaterThan(SCAFFOLD_BUNDLES.length)

  const home = await mkdtemp(join(tmpdir(), 'dsh-swarm-profile-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  const profile = loadProfile('swarm composition test', TEMPLATE_NAME, join(REPO_ROOT, 'apps/cli/package.json'), home)
  expect(profile.layers.map(layer => layer.packageName)).toEqual(bundles)
  const composed = composeEntries(profile.layers.map(layer => layer.patches))

  // The effective entry list the launcher would mount, including expanded capacity.
  expectConfig(composed, 'subagent', { maxConcurrentRuns: 8 })
  expectConfig(composed, 'agent-team', { maxMembers: 16 })
  expectConfig(composed, 'tool-agent-team', { coordination: 'swarm' })
  const composedNames = composed.map(entry => entry.name)
  for (const row of REQUIRED_CLIENT_ROWS) expect(composedNames).toContain(row)

  // Boot the remaining layers over the scaffold's shipped base and Web surface,
  // in the template's own order, from the same files the launcher would read.
  const overlays = profile.layers.slice(SCAFFOLD_BUNDLES.length)
  scaffold = await launchWebScaffold({
    extraOverlayPath: overlays.map(layer => layer.patchPath),
    extraInstallAnchors: overlays.map(layer => join(layer.packageDir, 'package.json')),
  })
  const ctx = scaffold.ctx

  const booted = [...ctx.loader.entries()].map(entry => entry.options)
  expectConfig(booted, 'subagent', { maxConcurrentRuns: 8 })
  expectConfig(booted, 'agent-team', { maxMembers: 16 })
  expectConfig(booted, 'tool-agent-team', { coordination: 'swarm' })

  // The run ceiling is realized by the seam, not just declared in a row.
  expect(ctx.subagents.capacity()).toEqual({ limit: 8, active: 0, waiting: 0 })

  // The browser roster the Host serves: both rows resolved to real client bundles.
  const clientRows = ctx.clientModules.graph().entries.map(entry => entry.id)
  for (const row of REQUIRED_CLIENT_ROWS) expect(clientRows).toContain(row)
  await exerciseSwarmComposer(scaffold, 'swarm')

  const handle = await ctx.agents.create({
    sessionId: SessionId('swarm-web-composition'),
    meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  onTestFinished(() => handle.dispose())
  expect(ctx.agentTeams.membership(handle.agent).role).toBe('lead')
  await expect.poll(() => ctx.commands.list(handle.agent).map(command => command.name)).toContain('swarm')
  const signal = new AbortController().signal
  expect((await ctx.commands.execute(handle.agent, '/swarm   ', [], signal))?.result).toEqual({
    kind: 'error', text: 'Describe the work after /swarm.',
  })
  expect(handle.agent.inbox.hasPending).toBe(false)
  const maintenance = Promise.withResolvers<undefined>()
  const held = handle.agent.runMaintenance((signal) => {
    signal.addEventListener('abort', () => { maintenance.resolve(undefined) }, { once: true })
    return maintenance.promise
  })
  onTestFinished(async () => {
    handle.agent.inbox.clear()
    maintenance.resolve(undefined)
    await held
  })
  expect((await ctx.commands.execute(handle.agent, '/swarm Review keyboard navigation', [], signal))?.result).toEqual({
    kind: 'success', text: 'Swarm request queued.',
  })
  expect(handle.agent.inbox.nextTurn).toHaveLength(1)
  expect(handle.agent.inbox.nextTurn[0]?.content).toEqual([{ type: 'text', text: '/swarm Review keyboard navigation' }])
  expect(handle.agent.inbox.nextTurn[0]?.source).toEqual({ kind: 'user' })
  handle.agent.inbox.clear()
  maintenance.resolve(undefined)
  await held
  const assembled = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
  expect(assembled.tools.map(schema => schema.name)).toContain('team_task_claim_next')
  const prompt = renderPrompt(assembled)
  expect(prompt).toContain('This session runs as a swarm')
  expect(prompt).toContain('Do not name a specific task in a teammate\'s prompt')
  expect(prompt).not.toContain('create teammates only when the user explicitly asks')
  const excluded = await ctx.agents.create({
    sessionId: SessionId('swarm-excluded-preset'),
    meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
    agentOptions: {},
  })
  onTestFinished(() => excluded.dispose())
  expect(ctx.commands.find(excluded.agent, 'swarm')).toBeUndefined()
  expect(await ctx.commands.execute(excluded.agent, '/swarm Work', [], signal)).toBeUndefined()
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'tool-agent-team')
  if (entry?.fiber === undefined) throw new Error('Swarm tool plugin has no live fiber')
  await entry.fiber.dispose()
  await expect.poll(() => ctx.commands.find(handle.agent, 'swarm')).toBeUndefined()
  await handle.dispose()
  expect(ctx.commands.find(handle.agent, 'swarm')).toBeUndefined()
}, 180_000)

it('shows and submits swarm commands in the default web profile', async () => {
  expect(PROFILE_TEMPLATES.web?.bundles).toEqual(SCAFFOLD_BUNDLES)
  scaffold = await launchWebScaffold()
  await exerciseSwarmComposer(scaffold, 'default-web-swarm')
}, 180_000)

async function exerciseSwarmComposer(host: WebScaffold, screenshotName: string): Promise<void> {
  const browser = await launchBrowser()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const errors: string[] = []
  page.on('pageerror', (error) => { errors.push(error.message) })
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  await page.goto(host.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspace(page, host.workspaceCwd)
  const agent = host.ctx.agents.list()[0]
  if (agent === undefined) throw new Error('The browser workspace has no lead')
  const input = page.locator('[data-composer-input]').first()
  await input.click()
  await input.press('/')
  const swarmOption = page.getByRole('option', { name: 'swarm Ask this swarm to coordinate a request', exact: true })
  const goalOption = page.getByRole('option', { name: 'goal set or view the goal for a long-running task', exact: true })
  await swarmOption.waitFor()
  await goalOption.waitFor()
  expect(await swarmOption.isVisible()).toBe(true)
  expect(await goalOption.isVisible()).toBe(true)
  await page.screenshot({ path: `.artifacts/finish/${screenshotName}-goal-command-preview.png` })
  await input.pressSequentially('swarm')
  await swarmOption.waitFor()
  await input.press('Enter')
  await expect.poll(() => input.textContent()).toBe('/swarm ')
  await page.screenshot({ path: `.artifacts/finish/${screenshotName}-command-selected.png` })
  expect(agent.inbox.hasPending).toBe(false)
  const maintenance = Promise.withResolvers<undefined>()
  const held = agent.runMaintenance((signal) => {
    signal.addEventListener('abort', () => { maintenance.resolve(undefined) }, { once: true })
    return maintenance.promise
  })
  onTestFinished(async () => {
    agent.inbox.clear()
    maintenance.resolve(undefined)
    await held
  })
  await input.press('End')
  await input.pressSequentially('Review the Settings and Agent Team journeys')
  await input.press('Enter')
  await page.screenshot({ path: `.artifacts/finish/${screenshotName}-command-submitted.png` })
  await expect.poll(() => agent.inbox.nextTurn.map(message => message.content)).toEqual([
    [{ type: 'text', text: '/swarm Review the Settings and Agent Team journeys' }],
  ])
  await expect.poll(() => input.textContent()).toBe('')
  expect(agent.session.events.some(event => event.type === 'command/done'
    && event.data.kind === 'success' && event.data.text === 'Swarm request queued.')).toBe(true)
  const queuedRequest = page.getByText('/swarm Review the Settings and Agent Team journeys', { exact: true })
  await queuedRequest.waitFor()
  expect(await queuedRequest.isVisible()).toBe(true)
  await page.screenshot({ path: `.artifacts/finish/verified-${screenshotName}-command.png` })
  expect(errors).toEqual([])
  agent.inbox.clear()
  maintenance.resolve(undefined)
  await held
}
