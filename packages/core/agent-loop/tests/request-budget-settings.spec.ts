import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { REQUEST_BUDGET_SETTINGS_NAMESPACE, type RequestBudgetPolicy } from '@deepseek-ai/dsh-session/types'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { FileSettingsProvider } from '../../../settings/settings-file/src/index.ts'
import AgentLoop from '../src/index.ts'

const namespace = settingsNamespace(REQUEST_BUDGET_SETTINGS_NAMESPACE)
const policy: RequestBudgetPolicy = { policyId: 'test/durable-request-budget', maxAgentAttempts: 32, maxRootAttempts: 128 }

async function documentPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'request-budget-settings-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'settings.json')
}

async function boot(path: string, requestBudget?: RequestBudgetPolicy) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const settingsFiber = ctx.plugin(FileSettingsProvider, { path, watch: false })
  await settingsFiber.await()
  const loopFiber = ctx.plugin(AgentLoop, { agents: [], ...requestBudget === undefined ? {} : { requestBudget } })
  await loopFiber.await()
  return { ctx, settingsFiber, loopFiber }
}

it('registers no request policy or settings namespace without deployment configuration', async () => {
  const path = await documentPath()
  const { ctx } = await boot(path)
  expect(ctx.agentLoop.config.requestBudget).toBeUndefined()
  expect(ctx.get('requestBudgetPolicy')).toBeUndefined()
  expect(ctx.settings.describe().map(row => row.ns)).toEqual(['agent-loop'])
  await expect(ctx.settings.update(namespace, { maxRootAttempts: 256 })).rejects.toThrow('is not registered')
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('loads the actual plugin configuration and registers one host namespace across agent lifecycles', async () => {
  const { ctx } = await boot(await documentPath(), policy)
  expect(ctx.agentLoop.config.requestBudget).toEqual(policy)
  expect(ctx.requestBudgetPolicy.get()).toEqual(policy)
  const first = await ctx.agents.create({ sessionId: SessionId('request-settings-first') })
  const second = await ctx.agents.create({ sessionId: SessionId('request-settings-second') })
  expect(ctx.settings.describe().filter(row => row.ns === namespace)).toEqual([
    expect.objectContaining({
      ns: namespace, applies: 'live', revision: 0,
      base: { maxAgentAttempts: 32, maxRootAttempts: 128 },
      value: { maxAgentAttempts: 32, maxRootAttempts: 128 },
    }),
  ])
  expect(first.agent.session.events).toEqual([])
  expect(second.agent.session.events).toEqual([])
  await first.dispose()
  await second.dispose()
  expect(ctx.requestBudgetPolicy.get()).toEqual(policy)
})

it.each([
  { ...policy, policyId: '' },
  { ...policy, policyId: ' untrimmed ' },
  { ...policy, maxAgentAttempts: 0 },
  { ...policy, maxAgentAttempts: -1 },
  { ...policy, maxAgentAttempts: 1.5 },
  { ...policy, maxRootAttempts: Number.POSITIVE_INFINITY },
  { ...policy, maxRootAttempts: Number.NaN },
  { ...policy, maxRootAttempts: Number.MAX_SAFE_INTEGER + 1 },
  { ...policy, maxAgentAttempts: 129 },
])('rejects invalid deployment policy before the host can use it: %j', async (invalid) => {
  const path = await documentPath()
  await expect(boot(path, invalid)).rejects.toThrow()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  { maxAgentAttempts: 0 },
  { maxAgentAttempts: -1 },
  { maxAgentAttempts: 1.5 },
  { maxRootAttempts: 0 },
  { maxRootAttempts: Number.POSITIVE_INFINITY },
  { maxRootAttempts: Number.NaN },
  { maxRootAttempts: Number.MAX_SAFE_INTEGER + 1 },
  { maxRootAttempts: 31 },
  { policyId: 'changed-accounting-identity' },
  { unrecognizedLimit: 1000 },
])('rejects invalid user settings without changing the file, policy or revision: %j', async (invalid) => {
  const path = await documentPath()
  const { ctx } = await boot(path, policy)
  await ctx.settings.update(namespace, { maxRootAttempts: 128 })
  const beforeFile = await readFile(path, 'utf8')
  const beforeDescriptor = ctx.settings.describe()
  await expect(ctx.settings.update(namespace, invalid)).rejects.toThrow()
  expect(ctx.requestBudgetPolicy.get()).toEqual(policy)
  expect(ctx.settings.describe()).toEqual(beforeDescriptor)
  expect(await readFile(path, 'utf8')).toBe(beforeFile)
})

it('persists live limits across restart and durably resets to the deployment limits', async () => {
  const path = await documentPath()
  const first = await boot(path, policy)
  const original = first.ctx.requestBudgetPolicy.get()
  expect(Object.isFrozen(original)).toBe(true)
  await first.ctx.settings.update(namespace, { maxAgentAttempts: 48, maxRootAttempts: 192 }, 0)
  const updated = { ...policy, maxAgentAttempts: 48, maxRootAttempts: 192 }
  expect(first.ctx.requestBudgetPolicy.get()).toEqual(updated)
  expect(original).toEqual(policy)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    [namespace]: { maxAgentAttempts: 48, maxRootAttempts: 192 },
  })
  await first.ctx.fiber.dispose()
  const second = await boot(path, policy)
  expect(second.ctx.requestBudgetPolicy.get()).toEqual(updated)
  await second.ctx.settings.mutate(namespace, [{ op: 'unset', path: [] }], 0)
  expect(second.ctx.requestBudgetPolicy.get()).toEqual(policy)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ [namespace]: {} })
  await second.ctx.fiber.dispose()
  const third = await boot(path, policy)
  expect(third.ctx.requestBudgetPolicy.get()).toEqual(policy)
})

it('retains the last committed limits when the real settings file cannot be replaced', async () => {
  const path = await documentPath()
  const { ctx } = await boot(path, policy)
  await ctx.settings.update(namespace, { maxRootAttempts: 160 })
  const beforeFile = await readFile(path, 'utf8')
  const beforeDescriptor = ctx.settings.describe()
  await rename(path, `${path}.saved`)
  await mkdir(path)
  await expect(ctx.settings.update(namespace, { maxRootAttempts: 192 })).rejects.toThrow()
  expect(ctx.requestBudgetPolicy.get()).toEqual({ ...policy, maxRootAttempts: 160 })
  expect(ctx.settings.describe()).toEqual(beforeDescriptor)
  await rm(path, { recursive: true })
  await rename(`${path}.saved`, path)
  expect(await readFile(path, 'utf8')).toBe(beforeFile)
  await ctx.settings.update(namespace, { maxRootAttempts: 192 })
  expect(ctx.requestBudgetPolicy.get()).toEqual({ ...policy, maxRootAttempts: 192 })
})

it('refuses agent-originated updates, replacement and reset across the native asynchronous initiator boundary', async () => {
  const path = await documentPath()
  const { ctx } = await boot(path, policy)
  const handle = await ctx.agents.create({ sessionId: SessionId('request-settings-initiator') })
  await ctx.settings.update(namespace, { maxRootAttempts: 160 })
  const beforeFile = await readFile(path, 'utf8')
  const beforeDescriptor = ctx.settings.describe()
  await ctx.agents.withInitiator(handle.agent, async () => {
    await Promise.resolve()
    await expect(ctx.settings.update(namespace, { maxRootAttempts: 192 })).rejects.toThrow('require a user settings operation')
    await expect(ctx.settings.replace(namespace, {})).rejects.toThrow('require a user settings operation')
    await expect(ctx.settings.mutate(namespace, [{ op: 'unset', path: [] }])).rejects.toThrow('require a user settings operation')
  })
  expect(ctx.settings.describe()).toEqual(beforeDescriptor)
  expect(await readFile(path, 'utf8')).toBe(beforeFile)
  expect(ctx.requestBudgetPolicy.get()).toEqual({ ...policy, maxRootAttempts: 160 })
  expect(handle.agent.session.events).toEqual([])
  await handle.dispose()
  await ctx.settings.update(namespace, { maxRootAttempts: 192 })
  expect(ctx.requestBudgetPolicy.get()).toEqual({ ...policy, maxRootAttempts: 192 })
})

it('releases the policy and namespace with the agent-loop owner', async () => {
  const { ctx, loopFiber } = await boot(await documentPath(), policy)
  expect(ctx.requestBudgetPolicy.get()).toEqual(policy)
  await loopFiber.dispose()
  expect(ctx.get('requestBudgetPolicy')).toBeUndefined()
  expect(ctx.settings.describe()).toEqual([])
  await expect(ctx.settings.update(namespace, { maxRootAttempts: 192 })).rejects.toThrow('is not registered')
})

it('leaves an invalid persisted policy unavailable and retains the invalid document', async () => {
  const path = await documentPath()
  const text = JSON.stringify({ [namespace]: { maxAgentAttempts: 129 } })
  await writeFile(path, text)
  const { ctx } = await boot(path, policy)
  expect(ctx.get('requestBudgetPolicy')).toBeUndefined()
  expect(() => ctx.requestBudgetPolicy.get()).toThrow()
  expect(ctx.settings.describe().map(row => row.ns)).toEqual(['agent-loop'])
  expect(await readFile(path, 'utf8')).toBe(text)
})
