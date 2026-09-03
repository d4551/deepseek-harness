/**
 * The user-owned Team capacities: what the settings section serves the browser
 * card, and when a stored change takes effect. The section is a strict subset
 * of the plugin config — the mailbox budgets and the disposal deadline stay
 * composition-only, and storing them is refused rather than ignored.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService, { AGENT_TEAM_SETTINGS_NAMESPACE } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Mount the Team service over a file-backed settings document. */
async function setup(config: ConstructorParameters<typeof TeamService>[1] = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-settings-'))
  const settingsHome = mkdtempSync(join(tmpdir(), 'dsh-team-home-'))
  roots.push(storageRoot, settingsHome)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const settingsFiber = await ctx.plugin(FileSettingsProvider, { dshHome: settingsHome, watch: false })
  await ctx.plugin(TeamService, config)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
  const lead = ctx.agentLoop.create(SessionId('settings-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, settingsFiber }
}

/** Create one teammate through the service. */
function spawn(ctx: Context, lead: Agent, name: string) {
  return ctx.agentTeams.spawnTeammate(lead, {
    name,
    description: `${name} responsibility`,
    prompt: [{ type: 'text', text: `${name} initial` }],
    context: 'fresh',
    provider: 'spawn',
    signal: SIGNAL,
  })
}

describe('Team settings section', () => {
  it('serves exactly the capacities a user owns, seeded from the composition entry', async () => {
    const { ctx } = await setup({ maxMembers: 3, maxTasks: 9, maxMessageBytes: 4096 })

    const descriptor = ctx.settings.describe()
      .find(entry => entry.ns === AGENT_TEAM_SETTINGS_NAMESPACE)

    expect(descriptor?.value).toEqual({ maxMembers: 3, maxTasks: 9 })
    expect(descriptor?.base).toEqual({ maxMembers: 3, maxTasks: 9 })
  })

  it('refuses a composition-owned field stored in the section instead of ignoring it', async () => {
    const { ctx } = await setup()

    await expect(ctx.settings.update(AGENT_TEAM_SETTINGS_NAMESPACE, { maxMessageBytes: 1024 }))
      .rejects.toThrow(/maxMessageBytes is a composition field/)
    expect(ctx.settings.describe().find(entry => entry.ns === AGENT_TEAM_SETTINGS_NAMESPACE)?.user)
      .toBeUndefined()
  })

  it('bounds the next spawn by a capacity stored after the Team started', async () => {
    const { ctx, lead } = await setup({ maxMembers: 8 })
    await spawn(ctx, lead, 'first-worker')

    await ctx.settings.update(AGENT_TEAM_SETTINGS_NAMESPACE, { maxMembers: 1 })

    await expect(spawn(ctx, lead, 'second-worker'))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
    // The member admitted under the wider capacity keeps its place.
    expect(ctx.agentTeams.listMembers(lead).map(row => row.name)).toEqual(['lead', 'first-worker'])
  })

  it('bounds the next task by a capacity stored after the board was built', async () => {
    const { ctx, lead } = await setup({ maxTasks: 8 })
    await ctx.agentTeams.createTask(lead, { subject: 'first', description: 'first task' })

    await ctx.settings.update(AGENT_TEAM_SETTINGS_NAMESPACE, { maxTasks: 1 })

    await expect(ctx.agentTeams.createTask(lead, { subject: 'second', description: 'second task' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
  })

  it('keeps the last good capacities when a stored value is not a positive safe integer', async () => {
    const { ctx, lead } = await setup({ maxMembers: 1 })

    await expect(ctx.settings.update(AGENT_TEAM_SETTINGS_NAMESPACE, { maxMembers: Number.MAX_SAFE_INTEGER + 1 }))
      .rejects.toThrow(/maxMembers must be a positive safe integer/)

    await spawn(ctx, lead, 'first-worker')
    await expect(spawn(ctx, lead, 'second-worker'))
      .rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const { ctx, lead, settingsFiber } = await setup({ maxMembers: 2 })
    await ctx.settings.update(AGENT_TEAM_SETTINGS_NAMESPACE, { maxMembers: 1 })
    await spawn(ctx, lead, 'first-worker')
    await expect(spawn(ctx, lead, 'second-worker')).rejects.toMatchObject({ code: 'TEAM_MEMBER_LIMIT' })

    await settingsFiber.dispose()

    await spawn(ctx, lead, 'second-worker')
    expect(ctx.agentTeams.listMembers(lead).map(row => row.name))
      .toEqual(['lead', 'first-worker', 'second-worker'])
  })
})
