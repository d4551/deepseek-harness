import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as goalDriver from '../src/index.ts'

it('disarms a goal at the request budget without completing it or scheduling another round', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(GoalService)
  await ctx.plugin(goalDriver)
  await ctx.plugin(AgentLoop, { agents: [] })
  const history = Session.create(SessionId('goal-budget'))
  const policy = { policyId: 'test/goal-budget', maxAgentAttempts: 1, maxRootAttempts: 1 }
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Human work' }] })
  history.append('turn/start', { turn: 1 })
  history.append('user/message', human, { surfaceOp: 'append' })
  history.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const { agent } = await ctx.agents.create({
    sessionId: history.id, seed: [...history.events],
    agentOptions: { provider: 'unused', model: 'unused' },
  })
  let flushes = 0
  ctx.on('session/flush', () => { flushes += 1 })
  ctx.sessions.requestBudgets.admit(agent.session, policy, human.id)
  await ctx.sessions.requestBudgets.reserve(agent.session, agent.session, policy, new AbortController().signal)
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  const paused = Promise.withResolvers<undefined>()
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'request-budget') paused.resolve(undefined)
  })
  ctx.on('agent/request', async ({ signal }, next) => {
    await ctx.sessions.requestBudgets.reserve(agent.session, agent.session, policy, signal)
    return next()
  })
  const goal = ctx.goals.create(agent, { objective: 'Finish verified work', maxGoalRounds: 8 })
  await paused.promise
  await agent.whenIdle()
  await new Promise((resolve) => { setImmediate(resolve) })
  expect(ctx.goals.get(agent)).toMatchObject({ id: goal.id, phase: 'active', activation: 'disarmed', roundsStarted: 1 })
  expect(agent.status).toBe('idle')
  expect(agent.session.events.filter(event => event.type === 'turn/start')
    .map(event => event.data.turn)).toEqual([1, 2])
  expect(errors).toEqual([])
  expect(agent.session.events.filter(event => event.type === 'request/attempt')).toHaveLength(1)
  expect(agent.session.events.filter(event => event.type === 'user/message'
    && event.data.source.kind === 'goal' && event.data.source.round > 0)).toHaveLength(1)
  expect(flushes).toBeGreaterThanOrEqual(1)
})
