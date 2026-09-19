import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import * as timeContext from '@deepseek-ai/dsh-time-context'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

const leftovers: readonly Thrown[] = [
  { tag: 'leftover-object' },
  'leftover string',
  0,
  false,
  1n,
  Symbol.for('leftover-time-context'),
  null,
  undefined,
]

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(timeContext)
  return ctx
}

function sessionAgent(session: Session): Agent {
  return {
    id: SessionId('leftover'),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('time-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function contextTexts(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.events) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'time-context') {
      texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
    }
  }
  return texts
}

describe('leftover Promise reject arms', () => {
  it('preserves leftover next() refuses without committing a reading', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('leftover-next'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'turn 1' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const agent = sessionAgent(session)
    const proposed = createUserMessage({
      content: [{ type: 'text', text: 'request proposal' }],
      source: { kind: 'plugin', plugin: 'time-context-leftover' },
    })
    const signal = new AbortController().signal
    const leftoverHold: { value: Thrown } = { value: undefined }
    ctx.on('agent/pre-step', async () => {
      throw leftoverHold.value
    })

    for (const leftover of leftovers) {
      leftoverHold.value = leftover
      await expect(agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [proposed], turn: 1, step: 1, signal },
        () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
      )).rejects.toBe(leftover)
      expect(contextTexts(session)).toHaveLength(0)
    }
  })
})
