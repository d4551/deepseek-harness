import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { expect, it, onTestFinished } from 'vitest'
import TeamService, { foldTeam, type SpawnTeammateRequest, TeamId, type TeamMemberSnapshot } from '../src/index.ts'

async function team() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-roster-routing-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(TeamService, { maxMembers: 1 })
  const lead = ctx.agentLoop.create(SessionId('routing-lead'), { provider: 'initial', model: 'initial-model' })
  return { ctx, lead }
}

it('does not reserve names or roster capacity for invalid provider configuration', async () => {
  const { ctx, lead } = await team()
  await ctx.plugin(SubagentSpawn, { providerName: 'fresh-worker' })
  await ctx.plugin(SubagentFork, { providerName: 'history-worker' })
  const request: SpawnTeammateRequest = {
    name: 'reviewer', description: 'Review the changed code',
    prompt: [{ type: 'text', text: 'Review the changed code' }],
    context: 'fresh', signal: new AbortController().signal,
  }
  await expect(ctx.agentTeams.spawnTeammate(lead, { ...request, provider: 'absent' }))
    .rejects.toMatchObject({ code: 'TEAM_PROVIDER_UNAVAILABLE' })
  await expect(ctx.agentTeams.spawnTeammate(lead, { ...request, provider: 'history-worker' }))
    .rejects.toMatchObject({ code: 'TEAM_PROVIDER_CONTEXT' })
  await ctx.plugin(SubagentSpawn, { providerName: 'second-fresh-worker' })
  await expect(ctx.agentTeams.spawnTeammate(lead, request))
    .rejects.toMatchObject({ code: 'TEAM_PROVIDER_AMBIGUOUS' })
  expect([...foldTeam(lead.id, lead.session.events).members.values()]).toEqual([])
  expect(ctx.agentTeams.listMembers(lead).map(member => member.id)).toEqual([lead.id])
})

it('publishes request model changes and never assigns the lead model to an unloaded child', async () => {
  const { ctx, lead } = await team()
  expect(ctx.agentTeams.listMembers(lead)[0]?.model).toBe('initial-model')
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  const changes = ctx.agentTeams.changes(lead, controller.signal)[Symbol.asyncIterator]()
  expect(await changes.next()).toEqual({ value: 0, done: false })
  const updated = changes.next()
  lead.session.append('request/header', {
    reason: 'initial', header: { config: { provider: 'selected', model: 'selected-model' } },
  })
  expect(await updated).toEqual({ value: 1, done: false })
  expect(ctx.agentTeams.listMembers(lead)[0]?.model).toBe('selected-model')
  const member = {
    id: SessionId('unloaded-child'), name: 'reviewer', description: 'Review code',
    provider: 'fresh-worker', context: 'fresh', phase: 'provisioning',
  } satisfies TeamMemberSnapshot
  lead.session.append('team/member', { version: 1, teamId: TeamId(lead.id), member })
  expect(ctx.agentTeams.listMembers(lead)[1]).not.toHaveProperty('model')
  await ctx.sessions.flush(lead.session)
})
