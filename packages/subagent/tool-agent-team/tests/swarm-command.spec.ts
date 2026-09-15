import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime, { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService, { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { expect, it, onTestFinished, vi } from 'vitest'
import TeamService from '../../agent-team/src/index.ts'
import { installSwarmCommand } from '../src/swarm-command.ts'

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-swarm-command-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(TeamService)
  await ctx.plugin(CommandRuntime)
  const owner = await ctx.agents.create({ sessionId: SessionId('swarm-lead'), agentOptions: {} })
  const peer = await ctx.agents.create({ sessionId: SessionId('other-lead'), agentOptions: {} })
  return { ctx, owner, peer }
}

it('queues trimmed human requests during maintenance and removes only its scoped command on disposal', async () => {
  const { ctx, owner, peer } = await setup()
  const dispose = installSwarmCommand(owner.agent)
  await vi.waitFor(() => { expect(ctx.commands.find(owner.agent, 'swarm')).toBeDefined() })
  expect(ctx.commands.list(owner.agent)).toEqual([{
    name: 'swarm', description: 'Ask this swarm to coordinate a request',
    input: { hint: '<request>', images: true },
  }])
  expect(ctx.commands.list(peer.agent)).toEqual([])
  const release = Promise.withResolvers<string>()
  const maintenance = owner.agent.runMaintenance(() => release.promise)
  onTestFinished(async () => {
    owner.agent.cancel({ kind: 'user' })
    release.resolve('maintenance completed')
    await maintenance
  })
  const signal = new AbortController().signal
  const empty = await ctx.commands.execute(owner.agent, '/swarm \t\n', [], signal)
  expect(empty?.result).toEqual({ kind: 'error', text: 'Describe the work after /swarm.' })
  expect(owner.agent.inbox.nextTurn).toEqual([])
  const accepted = await ctx.commands.execute(owner.agent, '/swarm  Review the changes  \n', [], signal)
  expect(accepted?.result).toEqual({ kind: 'success', text: 'Swarm request queued.' })
  expect(owner.agent.inbox.nextTurn).toHaveLength(1)
  expect(owner.agent.inbox.nextTurn[0]).toMatchObject({
    content: [{ type: 'text', text: '/swarm Review the changes' }], source: { kind: 'user' },
  })
  expect(peer.agent.inbox.nextTurn).toEqual([])
  expect(owner.agent.session.events.filter(event => event.type === 'command/done').map(event => event.data.kind))
    .toEqual(['error', 'success'])
  await dispose()
  expect(ctx.commands.list(owner.agent)).toEqual([])
  expect(await ctx.commands.execute(owner.agent, '/swarm Further work', [], signal)).toBeUndefined()
  expect(owner.agent.inbox.nextTurn).toHaveLength(1)
})

it('rechecks live ownership and denies retained command calls after membership or context disposal', async () => {
  const { ctx, owner, peer } = await setup()
  installSwarmCommand(owner.agent)
  await vi.waitFor(() => { expect(ctx.commands.find(owner.agent, 'swarm')).toBeDefined() })
  const command = ctx.commands.find(owner.agent, 'swarm')
  if (command === undefined) throw new Error('swarm command was not registered')
  const invocation = {
    commandId: CommandId('retained-swarm-command'), rawInput: 'Review changes',
    attachments: [], signal: new AbortController().signal,
  }
  expect(await command.handler({ ...invocation, agent: peer.agent })).toEqual({
    kind: 'error', text: 'Only this swarm’s lead can submit a swarm request.',
  })
  expect(peer.agent.inbox.nextTurn).toEqual([])
  owner.agent.session.append('turn/start', { turn: 1 })
  owner.agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'one-shot', provider: 'spawn', label: 'Provider-owned child',
  }))
  owner.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(ctx.agentTeams.tryMembership(owner.agent)).toBeUndefined()
  expect(await command.handler({ ...invocation, agent: owner.agent })).toEqual({
    kind: 'error', text: 'Only this swarm’s lead can submit a swarm request.',
  })
  expect(owner.agent.inbox.nextTurn).toEqual([])
  await owner.dispose()
  expect(() => command.handler({ ...invocation, agent: owner.agent }))
    .toThrow('cannot get required service "agentTeams" in inactive context')
})

it('does not register a swarm command for a provider-owned child outside the team roster', async () => {
  const { ctx, owner } = await setup()
  owner.agent.session.append('turn/start', { turn: 1 })
  owner.agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({
    mode: 'one-shot', provider: 'spawn', label: 'Provider-owned child',
  }))
  owner.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(ctx.agentTeams.tryMembership(owner.agent)).toBeUndefined()
  let registryChanges = 0
  ctx.on('commands/change', () => { registryChanges += 1 })
  const registrations: Fiber[] = []
  ctx.on('internal/plugin', (fiber) => { registrations.push(fiber) })
  const dispose = installSwarmCommand(owner.agent)
  const registration = registrations.find(fiber => fiber.dispose === dispose)
  if (registration === undefined) throw new Error('swarm registration fiber was not published')
  await registration.await()
  expect(registryChanges).toBe(0)
  expect(ctx.commands.list(owner.agent)).toEqual([])
  await dispose()
  expect(registryChanges).toBe(0)
  expect(ctx.commands.list(owner.agent)).toEqual([])
})
