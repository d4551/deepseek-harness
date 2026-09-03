/**
 * The shared inbox fold and input-message classification: which queued ids a
 * splice admits into a running turn, and how one durable `user/message`
 * becomes a user, steering, or context record.
 */

import { describe, expect, it } from 'vitest'
import { applyInboxSplice, inputMessageNode, type InboxState } from '../src/messages.ts'
import type {
  ConversationMatch, ConversationPreviousContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

const previous = (state: InboxState): ConversationPreviousContext<InboxState> =>
  ({ state } as ConversationPreviousContext<InboxState>)

type MessageEvent = Extract<ConversationMatch['event'], { type: 'user/message' }>

const message = (source: unknown, id = 'm1'): MessageEvent => ({
  type: 'user/message',
  seq: 12,
  time: 120,
  data: { id, content: [{ type: 'text', text: 'hi' }], source },
} as unknown as MessageEvent)

describe('applyInboxSplice', () => {
  it('queues inserted identities from an empty history', () => {
    expect(applyInboxSplice(undefined, {
      target: 'next-turn', start: 0, inserted: [{ id: 'a' }, { id: 'b' }],
    })).toEqual({ pending: [{ id: 'a' }, { id: 'b' }], claimed: new Set() })
  })

  it('claims what a completed next-step splice removed', () => {
    const state = applyInboxSplice(
      previous({ pending: [{ id: 'a' }, { id: 'b' }], claimed: new Set() }),
      { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
    )
    expect(state.pending).toEqual([{ id: 'b' }])
    expect([...state.claimed]).toEqual(['a'])
  })

  it('claims nothing for a next-turn removal: those ids open their own turn', () => {
    const state = applyInboxSplice(
      previous({ pending: [{ id: 'a' }], claimed: new Set() }),
      { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
    )
    expect(state.pending).toEqual([])
    expect([...state.claimed]).toEqual([])
  })

  it('claims nothing when the splice was canceled', () => {
    const state = applyInboxSplice(
      previous({ pending: [{ id: 'a' }], claimed: new Set() }),
      { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' },
    )
    expect([...state.claimed]).toEqual([])
  })

  it('releases the claim on an identity a later splice re-queues', () => {
    const state = applyInboxSplice(
      previous({ pending: [], claimed: new Set(['a']) }),
      { target: 'next-step', start: 0, inserted: [{ id: 'a' }] },
    )
    expect([...state.claimed]).toEqual([])
    expect(state.pending).toEqual([{ id: 'a' }])
  })
})

describe('inputMessageNode', () => {
  it('classifies an unclaimed user message as a turn-opening user row', () => {
    expect(inputMessageNode(message({ kind: 'user' }), false)).toEqual({
      kind: 'user',
      seq: 12,
      time: 120,
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })
  })

  it('classifies a claimed user message as steering and keeps its inbox identity', () => {
    expect(inputMessageNode(message({ kind: 'user' }), true)).toEqual({
      kind: 'steering',
      messageId: 'm1',
      seq: 12,
      time: 120,
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })
  })

  it('classifies a non-user source as context and projects its provenance and form', () => {
    expect(inputMessageNode(
      message({ kind: 'plugin', plugin: 'dsh-tool-skill', form: 'notice' }),
      false,
    )).toEqual({
      kind: 'context',
      seq: 12,
      time: 120,
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'plugin', plugin: 'dsh-tool-skill', form: 'notice' },
      provenance: { role: 'inject', label: 'dsh-tool-skill' },
      form: 'notice',
    })
  })

  it('ignores the inbox claim for a non-user source', () => {
    expect(inputMessageNode(message({ kind: 'plugin', plugin: 'p' }), true).kind).toBe('context')
  })
})
