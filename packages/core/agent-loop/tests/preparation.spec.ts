import { expect, it, onTestFinished } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { harness, send } from './harness.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

it('awaits capability preparation before the first real request and omits revoked capabilities from the next one', async () => {
  const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
  const ctx = await harness(adapter)
  onTestFinished(() => ctx.fiber.dispose())
  const agent = ctx.agentLoop.create(SessionId('prepared-capabilities'), { provider: 'mock', model: 'mock' })
  const begun = Promise.withResolvers<undefined>()
  const permission = Promise.withResolvers<undefined>()
  const disposers: (() => void)[] = []
  let assemblies = 0
  ctx.systemPrompt.section({ name: 'assembly-count', order: 1, text: () => { assemblies += 1; return 'Standing policy' } })
  agent.ctx.on('agent/prepare-step', async ({ turn, signal }) => {
    if (turn === 1) {
      begun.resolve(undefined)
      await permission.promise
      signal.throwIfAborted()
      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'verified_capability', description: 'Verified session capability', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => Promise.resolve('available'),
      })))
      disposers.push(agent.ctx.systemPrompt.section({ name: 'verified-capability', order: 2, text: 'Verified capability policy' }))
    } else {
      for (const dispose of disposers) dispose()
    }
  })
  const order: string[] = []
  ctx.on('agent/pre-step', (_payload, next) => { order.push('pre-step'); return next() })
  send(agent, 'First request')
  await begun.promise
  expect(adapter.requests).toEqual([])
  expect(assemblies).toBe(0)
  expect(order).toEqual([])
  permission.resolve(undefined)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['verified_capability'])
  expect(adapter.requests[0]?.system).toContain('Verified capability policy')
  expect(assemblies).toBe(1)
  send(agent, 'After revocation')
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[1]?.tools ?? []).toEqual([])
  expect(adapter.requests[1]?.system).toBe('You are an AI agent powered by DeepSeek Harness.\n\nStanding policy')
  expect(assemblies).toBe(2)
  expect(order).toEqual(['pre-step', 'pre-step'])
})

it('preparation failure records the error and claimed-input lifecycle without spending a model request', async () => {
  const adapter = new MockAdapter([])
  const ctx = await harness(adapter)
  onTestFinished(() => ctx.fiber.dispose())
  const agent = ctx.agentLoop.create(SessionId('failed-preparation'), { provider: 'mock', model: 'mock' })
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  const failure = new Error('Required capability inventory could not be verified')
  agent.ctx.on('agent/prepare-step', () => { throw failure })
  send(agent, 'Keep this work available')
  await agent.whenIdle()
  expect(adapter.requests).toEqual([])
  expect(errors).toEqual([failure])
  expect(agent.inbox.nextTurn).toHaveLength(0)
  expect(agent.session.events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(2)
  expect(agent.session.events.filter(event => event.type === 'user/message' || event.type === 'step/start')).toEqual([])
  expect(agent.session.events.at(-1)).toMatchObject({
    type: 'turn/end', data: { reason: { kind: 'error', error: { message: failure.message } } },
  })
})

it('cancellation drains preparation and prevents assembly and the request', async () => {
  const adapter = new MockAdapter([])
  const ctx = await harness(adapter)
  onTestFinished(() => ctx.fiber.dispose())
  const agent = ctx.agentLoop.create(SessionId('cancelled-preparation'), { provider: 'mock', model: 'mock' })
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let drained = false
  agent.ctx.on('agent/prepare-step', async ({ signal }) => {
    started.resolve(undefined)
    await release.promise
    drained = true
    signal.throwIfAborted()
  })
  send(agent, 'Cancelled work')
  await started.promise
  agent.cancel({ kind: 'user' })
  expect(agent.status).toBe('running')
  expect(drained).toBe(false)
  release.resolve(undefined)
  await agent.whenIdle()
  expect(drained).toBe(true)
  expect(adapter.requests).toEqual([])
  expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
})
