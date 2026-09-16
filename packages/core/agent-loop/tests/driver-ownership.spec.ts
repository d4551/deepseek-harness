import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'

async function compose(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

it('drains cancelled preparation before running work admitted by its abort observer', async () => {
  const ctx = await compose()
  const handle = await ctx.agents.create({ sessionId: SessionId('native-cancelled-driver') })
  const { agent } = handle
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const statuses: string[] = []
  const errors: unknown[] = []
  ctx.on('agent/status', ({ status }) => { statuses.push(status) })
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  agent.ctx.on('agent/prepare-step', async ({ turn, signal }) => {
    if (turn !== 1) return
    signal.addEventListener('abort', () => { agent.followup(message('replacement')) }, { once: true })
    entered.resolve(undefined)
    await release.promise
    signal.throwIfAborted()
  })
  agent.ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))

  agent.followup(message('first'))
  await entered.promise
  let settled = false
  const idle = agent.whenIdle().then(() => { settled = true })
  const cause = { kind: 'user' } satisfies Parameters<typeof agent.cancel>[0]
  agent.cancel(cause)
  agent.cancel({ kind: 'parent' }, { keepInbox: true })
  expect(settled).toBe(false)
  expect(agent.status).toBe('running')
  release.resolve(undefined)
  await idle

  expect(statuses).toEqual(['running', 'idle', 'running', 'idle'])
  expect(errors).toEqual([])
  expect(agent.inbox.hasPending).toBe(false)
  expect(agent.session.events.filter(event => event.type === 'turn/end').map(event => event.data.reason))
    .toEqual([{ kind: 'aborted', reason: cause }, { kind: 'blocked' }])
  expect(agent.session.events.filter(event => event.type === 'step/start' || event.type === 'request/header')).toEqual([])
  await handle.dispose()
})

it('reports preparation failure before its terminal record and retains queued input for the next wake', async () => {
  const ctx = await compose()
  const handle = await ctx.agents.create({ sessionId: SessionId('native-failed-driver') })
  const { agent } = handle
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const failure = new Error('capability preparation denied')
  const order: string[] = []
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error); order.push('error') })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'turn/end') order.push(`end:${event.data.reason.kind}`)
  })
  agent.ctx.on('agent/prepare-step', async ({ turn }) => {
    if (turn !== 1) return
    entered.resolve(undefined)
    await release.promise
    throw failure
  })
  agent.ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
  agent.followup(message('first'))
  await entered.promise
  const queued = message('queued')
  agent.followup(queued)
  release.resolve(undefined)
  await agent.whenIdle()

  expect(errors).toEqual([failure])
  expect(order).toEqual(['error', 'end:error'])
  expect(agent.inbox.nextTurn).toEqual([queued])
  expect(agent.session.events.findLast(event => event.type === 'turn/end')?.data.reason)
    .toEqual({ kind: 'error', error: { message: failure.message, code: 'UNKNOWN' } })
  const wake = message('wake')
  agent.followup(wake)
  await agent.whenIdle()
  expect(order).toEqual(['error', 'end:error', 'end:blocked'])
  expect(agent.inbox.nextTurn).toEqual([wake])
  expect(agent.status).toBe('idle')
  await handle.dispose()
})

it('preserves caller cancellation diagnostics while awaiting unpublished scope cleanup', async () => {
  const ctx = await compose()
  const controller = new AbortController()
  const setupEntered = Promise.withResolvers<undefined>()
  const setupRelease = Promise.withResolvers<undefined>()
  const cleanupEntered = Promise.withResolvers<undefined>()
  const cleanupRelease = Promise.withResolvers<undefined>()
  onTestFinished(() => { setupRelease.resolve(undefined); cleanupRelease.resolve(undefined) })
  const id = SessionId('native-creation-cleanup')
  const creating = ctx.agents.create({
    sessionId: id,
    signal: controller.signal,
    setup: async (agentCtx) => {
      agentCtx.effect(() => async () => {
        cleanupEntered.resolve(undefined)
        await cleanupRelease.promise
      })
      setupEntered.resolve(undefined)
      await setupRelease.promise
    },
  })
  await setupEntered.promise
  const reason = { operation: 'stop creation' }
  let rejected = false
  const rejection = expect(creating).rejects.toMatchObject({
    message: `agent "${id}" creation aborted`, cause: reason,
  }).then(() => { rejected = true })
  controller.abort(reason)
  await cleanupEntered.promise
  expect(rejected).toBe(false)
  expect(ctx.agents.get(id)).toBeUndefined()
  expect(ctx.sessions.get(id)).toBeUndefined()
  cleanupRelease.resolve(undefined)
  setupRelease.resolve(undefined)
  await rejection
  const replacement = await ctx.agents.create({ sessionId: id })
  await replacement.dispose()
})
