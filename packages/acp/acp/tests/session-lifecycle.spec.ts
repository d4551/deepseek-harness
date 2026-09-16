import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PromptRequest, SessionNotification } from '@agentclientprotocol/sdk'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it, onTestFinished } from 'vitest'
import { AcpSession } from '../src/session.ts'

async function createSession() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acp-session-lifecycle-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  const options = {
    sessionId: SessionId('native-lifecycle'),
    cwd: root,
    mcpServers: [],
    agentOptions: {},
    fallbackSelection: undefined,
    signal: new AbortController().signal,
    notify: (notification: SessionNotification) => writeFile(
      join(root, 'delivered-notification.json'), JSON.stringify(notification),
    ),
  }
  const session = await AcpSession.create(ctx, options)
  ctx.on('session/event', (owner, event) => {
    if (session.ownsSession(owner)) session.onSessionEvent(owner, event)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (session.owns(agent)) session.onInboxClaimed(message, turn)
  })
  ctx.on('agent/error', ({ agent, turn, error }) => {
    if (session.owns(agent)) session.onAgentError(turn, error)
  })
  return { ctx, session, options }
}

describe('ACP session native lifecycle', () => {
  it('cancels an already-aborted request before queueing and releases its admission slot', async () => {
    const { ctx, session } = await createSession()
    const params: PromptRequest = { sessionId: session.agent.id, prompt: [{ type: 'text', text: 'begin' }] }
    await expect(session.prompt(params, false, AbortSignal.abort(new Error('already cancelled'))))
      .resolves.toEqual({ stopReason: 'cancelled' })
    expect(session.agent.inbox.hasPending).toBe(false)
    expect(session.agent.session.events).toEqual([])

    ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
    await expect(session.prompt(params, false)).resolves.toEqual({ stopReason: 'end_turn' })
    expect(session.agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'blocked' } },
    })
  })

  it('retains the prompt slot and close ownership until a cancelled extension has drained', async () => {
    const { ctx, session } = await createSession()
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    ctx.on('agent/prepare-step', async ({ signal }) => {
      entered.resolve(signal)
      await release.promise
    })
    const params: PromptRequest = { sessionId: session.agent.id, prompt: [{ type: 'text', text: 'begin' }] }
    const prompt = session.prompt(params, false)
    try {
      const signal = await entered.promise
      session.cancel()
      expect(signal.aborted).toBe(true)
      await expect(session.prompt(params, false)).rejects.toThrow(/already in flight/)
      let closed = false
      const closing = session.close('close cancelled prompt')
      expect(session.close('same close')).toBe(closing)
      const observedClose = closing.then(() => { closed = true })
      expect(() => session.configOptions()).toThrow(/session is closing/)
      expect(closed).toBe(false)
      expect(ctx.agents.get(session.agent.id)).toBe(session.agent)
      release.resolve(undefined)
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
      await observedClose
      expect(ctx.agents.get(session.agent.id)).toBeUndefined()
      const persisted = await ctx.sessionPersistence.load(session.agent.id)
      expect(persisted.events.at(-1)).toMatchObject({
        type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
    } finally {
      release.resolve(undefined)
    }
  })

  it('reports a real extension failure and releases the slot for the next prompt', async () => {
    const { ctx, session } = await createSession()
    const remove = ctx.on('agent/prepare-step', () => { throw new Error('extension preparation failed') })
    const params: PromptRequest = { sessionId: session.agent.id, prompt: [{ type: 'text', text: 'begin' }] }
    await expect(session.prompt(params, false)).rejects.toMatchObject({
      message: 'Internal error: turn failed: extension preparation failed',
    })
    remove()
    ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
    await expect(session.prompt(params, false)).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('resumes an empty persisted session with its configuration installed before publication', async () => {
    const { ctx, session, options } = await createSession()
    await ctx.sessionPersistence.ensureMaterialized(session.agent.session)
    await session.close('resume test')
    const resumed = await AcpSession.resume(ctx, options)
    expect(ctx.agents.get(session.agent.id)).toBe(resumed.agent)
    expect(resumed.agent).not.toBe(session.agent)
    await expect(resumed.configOptions()).resolves.toEqual([])
    await resumed.close('complete resume test')
    expect(ctx.agents.list()).toEqual([])
  })
})
