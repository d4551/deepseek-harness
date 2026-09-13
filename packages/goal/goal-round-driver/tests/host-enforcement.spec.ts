import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as goalDriver from '../src/index.ts'

class CompletionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Completion attempt' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('records host enforcement failure after correction steers and disarms automatic goal continuation', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(goalDriver)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new CompletionAdapter()
  ctx.llm.registerAdapter(['test'], adapter)
  const agent = ctx.agentLoop.create(SessionId('host-enforcement'), { provider: 'test', model: 'test' })
  const failure = new Error('HOST_QUALITY_ENFORCEMENT: correction allowance exhausted; unpaid debt retained')
  const failed = Promise.withResolvers<Error>()
  ctx.on('agent/error', ({ error }) => {
    if (!(error instanceof Error)) throw new Error('Expected a host enforcement Error')
    failed.resolve(error)
  })
  let corrections = 0
  const detach = agent.ctx.on('agent/turn-stopping', () => {
    if (corrections === 3) throw failure
    corrections += 1
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: `Correction ${corrections}: verification remains unpaid` }],
      source: { kind: 'plugin', plugin: 'host-enforcement', form: 'notice', summary: 'Verification remains unpaid' },
    }))
  })
  const goal = ctx.goals.create(agent, { objective: 'Require verified work', maxGoalRounds: 8 })
  expect(await failed.promise).toBe(failure)
  await agent.whenIdle()
  await new Promise((resolve) => { setImmediate(resolve) })

  expect(corrections).toBe(3)
  expect(adapter.requests).toHaveLength(4)
  expect(agent.status).toBe('idle')
  expect(agent.inbox.nextStep).toEqual([])
  expect(agent.inbox.nextTurn).toEqual([])
  expect(agent.session.events.filter(event => event.type === 'turn/end')).toEqual([
    expect.objectContaining({ data: { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: failure.message } } } }),
  ])
  expect(ctx.goals.get(agent)).toMatchObject({
    id: goal.id, phase: 'active', activation: 'disarmed', roundsStarted: 1,
  })
  expect(agent.session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'goal' && event.data.source.round > 0)).toHaveLength(1)

  detach()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explicit repair follow-up' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await new Promise((resolve) => { setImmediate(resolve) })
  expect(adapter.requests).toHaveLength(5)
  expect(agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({
    data: { turn: 2, reason: { kind: 'completed' } },
  })
  expect(ctx.goals.get(agent)).toMatchObject({ phase: 'active', activation: 'disarmed', roundsStarted: 1 })
})
