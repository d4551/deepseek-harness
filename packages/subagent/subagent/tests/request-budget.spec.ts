import { expect, it, onTestFinished, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentRuntime, { type SubagentRunEndInfo } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'

it.each(['one-shot', 'continuable'] as const)('preserves a %s child budget pause through settlement and cleanup', async (mode) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-child-budget-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(spawn, { providerName: 'spawn' })
  const history = Session.create(SessionId('budget-parent'))
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Authorized work' }] })
  history.append('turn/start', { turn: 1 })
  history.append('user/message', human, { surfaceOp: 'append' })
  history.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const { agent: parent } = await ctx.agents.create({
    sessionId: history.id, seed: [...history.events],
    agentOptions: { provider: 'unused', model: 'unused' },
  })
  const policy = { policyId: 'test/shared-child-budget', maxAgentAttempts: 1, maxRootAttempts: 1 }
  ctx.sessions.requestBudgets.admit(parent.session, policy, human.id)
  await ctx.sessions.requestBudgets.reserve(parent.session, parent.session, policy, new AbortController().signal)
  const errors: unknown[] = []
  const ended: SubagentRunEndInfo[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  ctx.on('subagent/end', (info) => { ended.push(info) })
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    await ctx.sessions.requestBudgets.reserve(parent.session, agent.session, policy, signal)
    return next()
  })
  const request = { prompt: [{ type: 'text' as const, text: 'Perform the delegated work' }], parent }
  let childId: SessionId
  if (mode === 'one-shot') {
    const run = await ctx.subagents.start('spawn', { ...request, signal: new AbortController().signal })
    childId = run.id
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'request-budget' })
    expect(ctx.agents.get(childId)?.session.events.findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'request-budget', budget: { actorAttempts: 0, rootAttempts: 1 } } } })
    await run.dispose()
  } else {
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn', label: 'Budget-limited child', request, signal: new AbortController().signal,
    })
    childId = started.childId
    await vi.waitFor(() => { expect(ended).toHaveLength(1) })
    await parent.whenIdle()
    const notices = parent.session.events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'subagent-settled')
    expect(notices).toHaveLength(1)
    expect(JSON.stringify(notices)).toContain('paused at the host request limit before it finished')
    expect(JSON.stringify(notices)).toContain('explicit human follow-up in the root conversation')
    const persisted = await ctx.sessionPersistence.load(childId)
    expect(persisted.events.findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'request-budget', budget: { actorAttempts: 0, rootAttempts: 1 } } } })
  }
  expect(ended).toHaveLength(1)
  expect(ended[0]).toMatchObject({ id: childId, stopReason: 'request-budget' })
  expect(ctx.agents.get(childId)).toBeUndefined()
  expect(errors).toEqual([])
  expect(parent.session.events.filter(event => event.type === 'request/attempt')).toHaveLength(1)
  expect(parent.session.events.filter(event => event.type === 'request/episode')).toHaveLength(1)
})
