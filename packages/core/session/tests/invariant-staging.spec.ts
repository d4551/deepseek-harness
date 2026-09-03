import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { InvariantFailure } from '@deepseek-ai/dsh-invariants'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { advanceOpenTurn, stageSessionEvents } from '@deepseek-ai/dsh-session/invariant-staging'
import type { OpenTurnCursor, SessionEventStaging } from '@deepseek-ai/dsh-session/invariant-staging'

/** Committed state of the sample relation the suite folds. */
interface MessageTrace extends OpenTurnCursor {
  messages: number
}

const MESSAGE_LIMIT = 2

/** Sample relation: user messages are turn-enclosed and bounded per session. */
function countUserMessage(
  trace: MessageTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): number | undefined {
  if (event.type !== 'user/message') return undefined
  if (trace.openTurn === null) fail('user/message appended outside any open turn')
  if (trace.messages === MESSAGE_LIMIT) fail(`session exceeded ${MESSAGE_LIMIT} user messages`)
  return trace.messages + 1
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Owner side of the fold, with the committed counts it published. */
function messageStaging(): {
  readonly committed: number[]
  readonly staging: SessionEventStaging<MessageTrace, number>
} {
  const committed: number[] = []
  const fail: InvariantFailure = (message) => {
    throw new Error(message)
  }
  return {
    committed,
    staging: {
      seed: (session) => {
        const trace: MessageTrace = { openTurn: null, messages: 0 }
        for (const event of session.events) {
          advanceOpenTurn(trace, event)
          const staged = countUserMessage(trace, event, fail)
          if (staged !== undefined) trace.messages = staged
        }
        return trace
      },
      publish: advanceOpenTurn,
      stage: (trace, event) => countUserMessage(trace, event, fail),
      claims: event => event.type === 'user/message',
      commit: (trace, staged) => {
        trace.messages = staged
        committed.push(staged)
        return trace
      },
      unstagedMessage: 'user message published without pre-commit validation',
    },
  }
}

async function mount<TState extends object, TStaged>(
  ctx: Context,
  staging: SessionEventStaging<TState, TStaged>,
  fail: InvariantFailure = (message) => {
    throw new Error(message)
  },
): Promise<Awaited<ReturnType<Context['plugin']>>> {
  return ctx.plugin(Object.assign((inner: Context) => {
    stageSessionEvents(inner, fail, staging)
  }, { inject: ['sessions'] }))
}

async function store(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

describe('advanceOpenTurn', () => {
  it('follows turn boundaries and reports every other event as unclaimed', () => {
    const cursor: OpenTurnCursor = { openTurn: null }
    expect(advanceOpenTurn(cursor, { type: 'turn/start', seq: 0, time: 0, data: { turn: 4 } })).toBe(true)
    expect(cursor.openTurn).toBe(4)
    expect(advanceOpenTurn(cursor, {
      type: 'step/start', seq: 1, time: 0, data: { turn: 4, step: 1 },
    })).toBe(false)
    expect(cursor.openTurn).toBe(4)
    expect(advanceOpenTurn(cursor, {
      type: 'turn/end', seq: 2, time: 0, data: { turn: 4, reason: { kind: 'completed' } },
    })).toBe(true)
    expect(cursor.openTurn).toBeNull()
  })
})

describe('stageSessionEvents', () => {
  it('commits one staged result per published event and rejects the append that violates the relation', async () => {
    const ctx = await store()
    const { committed, staging } = messageStaging()
    await mount(ctx, staging)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage('one'), { surfaceOp: 'append' })
    session.append('user/message', userMessage('two'), { surfaceOp: 'append' })
    expect(committed).toEqual([1, 2])

    const before = session.events.length
    expect(() => session.append('user/message', userMessage('three'), { surfaceOp: 'append' }))
      .toThrow(/exceeded 2 user messages/)
    expect(session.events).toHaveLength(before)
    expect(committed).toEqual([1, 2])
  })

  it('seeds sessions the store already holds and sessions announced later', async () => {
    const ctx = await store()
    const existing = ctx.sessions.create(SessionId('already-open'))
    existing.append('turn/start', { turn: 1 })
    existing.append('user/message', userMessage('seeded'), { surfaceOp: 'append' })

    const { committed, staging } = messageStaging()
    await mount(ctx, staging)
    const announced = ctx.sessions.create(SessionId('announced-later'))
    announced.append('turn/start', { turn: 1 })
    announced.append('user/message', userMessage('first'), { surfaceOp: 'append' })
    expect(committed).toEqual([1])

    existing.append('user/message', userMessage('second'), { surfaceOp: 'append' })
    expect(committed).toEqual([1, 2])
    expect(() => existing.append('user/message', userMessage('third'), { surfaceOp: 'append' }))
      .toThrow(/exceeded 2 user messages/)
  })

  it('adopts a session first observed through publication', async () => {
    const ctx = await store()
    const { committed, staging } = messageStaging()
    await mount(ctx, staging)
    const bare = Session.create(SessionId('never-entered'))
    ctx.emit('session/event', bare, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
    ctx.emit('session/event', bare, {
      type: 'user/message', seq: 1, time: 1, data: userMessage('adopted'), surfaceOp: 'append',
    })
    expect(committed).toEqual([1])
  })

  it('fails a claimed event that dispatch never staged', async () => {
    const ctx = await store()
    await mount<object, never>(ctx, {
      seed: () => ({}),
      stage: () => undefined,
      claims: event => event.type === 'turn/start',
      commit: state => state,
      unstagedMessage: 'turn boundary published without pre-commit validation',
    })
    const session = Session.create(SessionId('claims-without-staging'))
    expect(() => {
      ctx.emit('session/event', session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
    }).toThrow('turn boundary published without pre-commit validation')
  })

  it('fails a published event whose staged result belongs to another session', async () => {
    const ctx = await store()
    // Only the session carrying durable events stages and skips publication,
    // so its staged entry is still pending when the bare session publishes the
    // same event object.
    await mount<{ readonly durable: boolean }, string>(ctx, {
      seed: session => ({ durable: session.events.length > 0 }),
      publish: state => state.durable,
      stage: state => (state.durable ? 'pending' : undefined),
      claims: () => true,
      commit: state => state,
      unstagedMessage: 'session event published without pre-commit validation',
    })
    const seeded = ctx.sessions.create(SessionId('carries-events'), { seed: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ] })
    const bare = Session.create(SessionId('carries-nothing'))
    const shared: SessionEvent = { type: 'turn/end', seq: 9, time: 9, data: { turn: 1, reason: { kind: 'completed' } } }

    ctx.emit('session/event', seeded, shared)
    expect(() => {
      ctx.emit('session/event', bare, shared)
    }).toThrow('session event published without pre-commit validation')
  })

  it('removes its listeners when the installing fiber is disposed', async () => {
    const ctx = await store()
    const { committed, staging } = messageStaging()
    const fiber = await mount(ctx, staging)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMessage('one'), { surfaceOp: 'append' })
    await fiber.dispose()

    session.append('user/message', userMessage('two'), { surfaceOp: 'append' })
    session.append('user/message', userMessage('three'), { surfaceOp: 'append' })
    expect(committed).toEqual([1])
  })
})
