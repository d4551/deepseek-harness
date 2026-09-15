import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { RequestBudgetExhausted, SessionId } from '@deepseek-ai/dsh-session'
import { harness } from './harness.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

it('pauses after 32 requests, retains tool work, and resumes only after new human admission', async () => {
  const responses = Array.from({ length: 32 }, (_, index) =>
    toolCallResponse(`progress-${index}`, 'record_progress', { progress: index + 1 }, `Progress ${index + 1}`))
  const provider = new MockAdapter([...responses, textResponse('Explicit continuation completed')])
  const ctx = await harness(provider)
  onTestFinished(() => ctx.fiber.dispose())
  const agent = ctx.agentLoop.create(SessionId('budget-pause'), { provider: 'mock', model: 'mock' })
  const policy = { policyId: 'test/finite-request-budget', maxAgentAttempts: 32, maxRootAttempts: 64 }
  const progress: number[] = []
  const errors: unknown[] = []
  let flushes = 0
  let retries = 0
  ctx.on('session/flush', () => { flushes += 1 })
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  ctx.on('agent/request-error', async () => { retries += 1; return { kind: 'retry' } })
  ctx.on('agent/request', async ({ agent: actor, signal }, next) => {
    await ctx.sessions.requestBudgets.reserve(agent.session, actor.session, policy, signal)
    return next()
  })
  ctx.tools.register({
    name: 'record_progress', description: 'Record one completed unit of work.',
    parameters: { type: 'object', properties: { progress: { type: 'integer' } }, required: ['progress'] },
    output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: String(value) }] },
    execute: async ({ progress: value }) => {
      if (typeof value !== 'number') throw new Error('Progress must be numeric')
      progress.push(value)
      return `Recorded ${value}`
    },
  })
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Work until the host limit' }] })
  ctx.sessions.requestBudgets.offer(agent.session, policy, human.id)
  agent.followup(human)
  await agent.whenIdle()

  expect(provider.requests).toHaveLength(32)
  expect(progress).toEqual(Array.from({ length: 32 }, (_, index) => index + 1))
  expect(agent.status).toBe('idle')
  expect(errors).toEqual([])
  expect(retries).toBe(0)
  expect(flushes).toBe(32)
  expect(agent.session.events.filter(event => event.type === 'step/start')).toHaveLength(33)
  expect(agent.session.events.filter(event => event.type === 'step/end')).toHaveLength(33)
  expect(agent.session.events.findLast(event => event.type === 'turn/end')).toMatchObject({ data: {
    turn: 1, reason: { kind: 'request-budget', budget: {
      policyId: policy.policyId, userMessageId: human.id, actorAttempts: 32, rootAttempts: 32,
      maxAgentAttempts: 32, maxRootAttempts: 64,
    } },
  } })

  const automated = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] })
  agent.followup(automated)
  await agent.whenIdle()
  expect(provider.requests).toHaveLength(32)
  expect(agent.session.events.filter(event => event.type === 'request/episode')).toHaveLength(1)
  expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('request-budget')
  await expect(ctx.sessions.requestBudgets.reserve(agent.session, agent.session, policy, new AbortController().signal))
    .rejects.toBeInstanceOf(RequestBudgetExhausted)

  const followup = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'I authorize another work episode' }] })
  ctx.sessions.requestBudgets.offer(agent.session, policy, followup.id)
  agent.followup(followup)
  await agent.whenIdle()
  expect(provider.requests).toHaveLength(33)
  expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  expect(agent.session.events.filter(event => event.type === 'request/attempt')).toHaveLength(33)
  expect(agent.session.events.filter(event => event.type === 'request/episode')).toHaveLength(2)
  expect(agent.session.events.findLast(event => event.type === 'request/attempt')).toMatchObject({ data: {
    userMessageId: followup.id, actorAttempt: 1, rootAttempt: 1,
  } })
  expect(provider.requests.at(-1)?.messages.flatMap(message => message.content)
    .some(block => block.type === 'text' && block.text === 'Progress 32')).toBe(true)
})

it('keeps missing admission and broken durability as errors instead of budget pauses', async () => {
  const provider = new MockAdapter([])
  const ctx = await harness(provider)
  onTestFinished(() => ctx.fiber.dispose())
  const agent = ctx.agentLoop.create(SessionId('budget-failure'), { provider: 'mock', model: 'mock' })
  const policy = { policyId: 'test/budget-failure', maxAgentAttempts: 1, maxRootAttempts: 1 }
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  ctx.on('agent/request', async ({ signal }, next) => {
    await ctx.sessions.requestBudgets.reserve(agent.session, agent.session, policy, signal)
    return next()
  })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Unadmitted input' }] }))
  await agent.whenIdle()
  expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
  const admitted = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Admitted input' }] })
  ctx.sessions.requestBudgets.offer(agent.session, policy, admitted.id)
  agent.followup(admitted)
  await agent.whenIdle()
  expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
  expect(errors).toHaveLength(2)
  expect(errors.every(error => !(error instanceof RequestBudgetExhausted))).toBe(true)
  expect(provider.requests).toHaveLength(0)
  expect(agent.session.events.filter(event => event.type === 'request/attempt')).toHaveLength(1)
})

it.each([true, false])('consumes input queued during the final tool without renewing unadmitted work (admitted: %s)', async (admitted) => {
  const provider = new MockAdapter([
    toolCallResponse('final-work', 'hold_work', {}, 'Preserved work'),
    textResponse('Authorized queued continuation'),
  ])
  const ctx = await harness(provider)
  onTestFinished(() => ctx.fiber.dispose())
  const agent = ctx.agentLoop.create(SessionId(`queued-budget-${admitted}`), { provider: 'mock', model: 'mock' })
  const policy = { policyId: 'test/queued-budget', maxAgentAttempts: 1, maxRootAttempts: 1 }
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let flushes = 0
  ctx.on('session/flush', () => { flushes += 1 })
  ctx.on('agent/request', async ({ signal }, next) => {
    await ctx.sessions.requestBudgets.reserve(agent.session, agent.session, policy, signal)
    return next()
  })
  ctx.tools.register({
    name: 'hold_work', description: 'Finish the current unit after explicit release.',
    parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: String(value) }] },
    execute: async () => {
      entered.resolve(undefined)
      await release.promise
      return 'Completed the held unit'
    },
  })
  const initial = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Perform one unit' }] })
  ctx.sessions.requestBudgets.offer(agent.session, policy, initial.id)
  agent.followup(initial)
  await entered.promise
  const queued = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the pending work' }] })
  if (admitted) ctx.sessions.requestBudgets.offer(agent.session, policy, queued.id)
  agent.followup(queued)
  release.resolve(undefined)
  await agent.whenIdle()
  expect(agent.status).toBe('idle')
  expect(agent.inbox.hasPending).toBe(false)
  expect(agent.session.events.filter(event => event.type === 'user/message').map(event => event.data.id))
    .toEqual([initial.id, queued.id])
  expect(agent.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
    .toEqual(['request-budget', admitted ? 'completed' : 'request-budget'])
  expect(provider.requests).toHaveLength(admitted ? 2 : 1)
  expect(flushes).toBe(admitted ? 2 : 1)
  expect(agent.session.events.filter(event => event.type === 'request/episode')).toHaveLength(admitted ? 2 : 1)
  expect(agent.session.events.filter(event => event.type === 'request/attempt')).toHaveLength(admitted ? 2 : 1)
  expect(agent.session.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
})
