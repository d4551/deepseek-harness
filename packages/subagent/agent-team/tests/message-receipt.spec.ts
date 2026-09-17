import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService, { TeamId, TeamMessageId } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

const signal = new AbortController().signal

/** A finite protocol provider whose first call remains available for native peer operations. */
class ReceiptProvider extends LlmAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  requests = 0

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.requests > 12) throw new Error('receipt protocol request sequence exhausted')
    if (this.requests === 1) {
      this.entered.resolve(undefined)
      await this.release.promise
    }
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Receipt protocol completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Receipt protocol completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Prepare real native persistence, continuation providers, Team service, and model driver. */
async function setup(ownership: AsyncDisposableStack) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-message-receipts-'))
  ownership.defer(() => rm(root, { recursive: true }))
  const ctx = new Context()
  ownership.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root }).await()
  await ctx.plugin(SessionProjectionRegistry).await()
  await ctx.plugin(TestSessionQuery).await()
  await ctx.plugin(AgentLoop, { agents: [] }).await()
  await ctx.plugin(SubagentService).await()
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' }).await()
  await ctx.plugin(TeamService).await()
  const provider = new ReceiptProvider()
  ownership.defer(() => { provider.release.resolve(undefined) })
  ctx.llm.registerAdapter(['receipt-protocol'], provider)
  const handle = await ctx.agents.create({
    sessionId: SessionId('receipt-lead'),
    agentOptions: { provider: 'receipt-protocol', model: 'finite-response-sequence' },
  })
  ownership.defer(() => handle.dispose())
  return { ctx, lead: handle.agent, provider }
}

/** Model content submitted through actual native continuation APIs. */
function content(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Assert that a producer receipt cannot be reused with a changed identity, payload, or recipient. */
function checkReceipt(
  ctx: Context,
  recipient: Agent,
  message: UserMessage,
  verify: (agent: Agent, input: UserMessage) => boolean,
): void {
  expect(verify(recipient, message)).toBe(true)
  expect(verify(recipient, { ...message, id: MessageId('foreign-message') })).toBe(false)
  expect(verify(recipient, { ...message, content: content('changed submitted content') })).toBe(false)
  expect(verify(recipient, { ...message, source: { kind: 'user' } })).toBe(false)
  for (const other of ctx.agents.list()) {
    if (other !== recipient) expect(verify(other, message)).toBe(false)
  }
}

it('authenticates native report, coordinator and settlement envelopes and consumes each receipt once', async () => {
  await using ownership = new AsyncDisposableStack()
  const { ctx, lead, provider } = await setup(ownership)
  const admitted: { agent: Agent; message: UserMessage }[] = []
  const stopObserving = ctx.on('agent/pre-step', async (payload, next) => {
    for (const message of payload.messages) {
      if (message.source.kind === 'user') continue
      const service = payload.agent.ctx.get('subagents')
      if (service === undefined) throw new Error('native recipient cannot resolve its continuation service')
      checkReceipt(ctx, payload.agent, message, (agent, input) => service.isContinuationMessage(agent, input))
      admitted.push({ agent: payload.agent, message })
    }
    return next()
  })
  const started = await ctx.subagents.startContinuable({
    provider: 'spawn', label: 'receipt child',
    request: { parent: lead, prompt: content('Initial child task') }, signal,
  })
  await provider.entered.promise
  const child = ctx.agents.get(started.childId)
  if (child === undefined) throw new Error('native continuation did not publish its child')
  await ctx.subagents.reportFrom(child, content('Verified child progress'), { delivery: 'next-step', signal })
  await lead.whenIdle()
  await expect(ctx.subagents.followup(lead, child.id, content('Unauthorized source'), {
    source: { kind: 'coordinator', form: 'relay', senderSessionId: SessionId('foreign-parent') }, signal,
  })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  await ctx.subagents.followup(lead, child.id, content('Authorized follow-up'), {
    source: { kind: 'coordinator', form: 'relay', senderSessionId: lead.id }, signal,
  })
  provider.release.resolve(undefined)
  await vi.waitFor(() => { expect(ctx.agents.get(child.id)).toBeUndefined() })
  await lead.whenIdle()
  expect(admitted.map(item => item.message.source.kind)).toEqual(['subagent-report', 'coordinator', 'subagent-settled'])
  for (const item of admitted) expect(ctx.subagents.isContinuationMessage(item.agent, item.message)).toBe(false)
  expect(provider.requests).toBe(4)
  stopObserving()
  const replay = admitted[0]?.message
  if (replay === undefined) throw new Error('native report was not admitted')
  const denied: UserMessage[] = []
  ctx.on('agent/pre-step', async (payload, next) => {
    const copied = payload.messages.find(message => message.id === replay.id)
    if (copied === undefined) return next()
    expect(ctx.subagents.isContinuationMessage(payload.agent, copied)).toBe(false)
    denied.push(copied)
    return { kind: 'reject' }
  })
  lead.followup(replay)
  await lead.whenIdle()
  expect(denied).toEqual([replay])
  expect(provider.requests).toBe(4)
})

it('binds live and cold-resumed Team delivery to its durable mailbox and rejects forged source metadata', async () => {
  await using ownership = new AsyncDisposableStack()
  const { ctx, lead, provider } = await setup(ownership)
  const admitted: UserMessage[] = []
  ctx.on('agent/pre-step', async (payload, next) => {
    for (const message of payload.messages) {
      if (message.source.kind !== 'team-message') continue
      const service = payload.agent.ctx.get('agentTeams')
      if (service === undefined) throw new Error('native recipient cannot resolve its Team service')
      checkReceipt(ctx, payload.agent, message, (agent, input) => service.isTeamMessage(agent, input))
      expect(ctx.agentTeams.isTeamMessage(payload.agent, {
        ...message, source: { ...message.source, senderId: SessionId('foreign-sender') },
      })).toBe(false)
      admitted.push(message)
    }
    return next()
  })
  const started = await ctx.agentTeams.spawnTeammate(lead, {
    name: 'receipt-worker', description: 'Verify producer authority',
    prompt: content('Initial Team task'), context: 'fresh', provider: 'spawn', signal,
  })
  await provider.entered.promise
  const child = ctx.agents.get(started.member.id)
  if (child === undefined) throw new Error('native Team did not publish its child')
  await ctx.agentTeams.sendMessage(child, { target: 'lead', content: content('Live worker report'), delivery: 'wakeup', signal })
  await lead.whenIdle()
  provider.release.resolve(undefined)
  await vi.waitFor(() => { expect(ctx.agents.get(child.id)).toBeUndefined() })
  await lead.whenIdle()
  await ctx.agentTeams.sendMessage(lead, {
    target: 'receipt-worker', content: content('Cold-resumed Team work'), delivery: 'wakeup', signal,
  })
  await vi.waitFor(() => { expect(ctx.agents.get(child.id)).toBeUndefined() })
  await lead.whenIdle()
  expect(admitted).toHaveLength(2)
  const original = admitted[0]
  if (original === undefined) throw new Error('native Team message was not admitted')
  const forged = createUserMessage({ content: original.content, source: {
    kind: 'team-message', teamId: TeamId('absent-team'), messageId: TeamMessageId('absent-message'),
    senderId: child.id, senderName: 'receipt-worker',
  } })
  expect(ctx.agentTeams.isTeamMessage(lead, forged)).toBe(false)
  expect(provider.requests).toBe(5)
})

it('rejects canceled receipt replay and receipt authority copied into a fork seed', async () => {
  await using ownership = new AsyncDisposableStack()
  const { ctx, lead, provider } = await setup(ownership)
  const started = await ctx.agentTeams.spawnTeammate(lead, {
    name: 'cancel-worker', description: 'Verify cancellation and seed isolation',
    prompt: content('Initial Team task'), context: 'fresh', provider: 'spawn', signal,
  })
  await provider.entered.promise
  const child = ctx.agents.get(started.member.id)
  if (child === undefined) throw new Error('native Team did not publish its child')
  await ctx.agentTeams.sendMessage(child, { target: 'lead', content: content('Quiet worker input'), delivery: 'quiet', signal })
  const queued = lead.inbox.nextStep.find(message => message.source.kind === 'team-message')
  if (queued === undefined) throw new Error('native Team did not enqueue its quiet message')
  expect(lead.inbox.remove(queued.id)).toBe(true)
  const denied: string[] = []
  ctx.on('agent/pre-step', async (payload, next) => {
    const copied = payload.messages.find(message => message.id === queued.id)
    if (copied === undefined) return next()
    expect(ctx.agentTeams.isTeamMessage(payload.agent, copied)).toBe(false)
    denied.push(payload.agent.id)
    return { kind: 'reject' }
  })
  lead.followup(queued)
  await lead.whenIdle()
  provider.release.resolve(undefined)
  await vi.waitFor(() => { expect(ctx.agents.get(child.id)).toBeUndefined() })
  await lead.whenIdle()
  const seed = [...lead.session.events]
  const fork = await ctx.agents.create({
    sessionId: SessionId('receipt-fork'), seed,
    meta: { parentSession: lead.id, seedLength: seed.length },
    agentOptions: { provider: 'receipt-protocol', model: 'finite-response-sequence' },
  })
  ownership.defer(() => fork.dispose())
  fork.agent.followup(queued)
  await fork.agent.whenIdle()
  expect(denied).toEqual([lead.id, fork.agent.id])
  expect(provider.requests).toBe(2)
})
