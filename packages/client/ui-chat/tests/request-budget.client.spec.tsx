// @vitest-environment jsdom

import { expect, it, onTestFinished } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  ConversationEventRegistry, ConversationViewRegistry, ConversationNodeAssembler,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { turnRequestBudgetDefinition } from '../src/client/conversation-nodes/turn-request-budget.ts'
import { turnMaxTokensDefinition } from '../src/client/conversation-nodes/turn-max-tokens.ts'
import { turnErrorDefinition } from '../src/client/conversation-nodes/turn-error.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { TurnRequestBudgetNodeView } from '../src/client/chat/TurnRequestBudgetNodeView.tsx'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { requireChatSnapshot } from '../src/client/contract/snapshot.ts'
import { en } from '../src/client/locale.ts'

it('keeps the typed budget pause visible through live assembly and history replay', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const events = new ConversationEventRegistry(ctx)
  const views = new ConversationViewRegistry(ctx)
  events.register(turnRequestBudgetDefinition)
  events.register(turnMaxTokensDefinition)
  events.register(turnErrorDefinition)
  views.register(chatViewDefinition)
  const session = Session.create(SessionId('budget-ui'))
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Complete the task' }] })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', human, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  const budget: Extract<TurnEndReason, { kind: 'request-budget' }>['budget'] = {
    version: 1, policyId: 'test/ui-budget', rootSessionId: session.id, actorSessionId: session.id,
    userMessageId: human.id, actorAttempts: 32, rootAttempts: 48, maxAgentAttempts: 32, maxRootAttempts: 64,
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'request-budget', budget } })
  const live = new ConversationNodeAssembler(events, views)
  for (const event of session.events) live.append({ type: 'event', event })
  live.flush()
  const replay = new ConversationNodeAssembler(events, views)
  replay.replaceWindow(structuredClone(session.events).map(event => ({ type: 'event', event })), false)
  replay.flush()
  const currentRaw = live.get('chat')
  const restoredRaw = replay.get('chat')
  if (currentRaw === undefined || restoredRaw === undefined) throw new Error('Chat projection was not produced')
  const current = requireChatSnapshot(currentRaw)
  const restored = requireChatSnapshot(restoredRaw)
  expect(current.nodes.values()).toEqual(restored.nodes.values())
  expect(current.order).toHaveLength(1)
  expect(current.nodes.values()[0]).toMatchObject({ kind: 'turn-request-budget', visibility: 'visible', data: {
    turn: 1, step: 1, budget,
  } })
  expect(current.legacy.nodes).toEqual([expect.objectContaining({ kind: 'turn-request-budget', budget })])
})

it('renders exact usage and explicit human continuation text as a persistent status', () => {
  onTestFinished(cleanup)
  const t = makeTranslate(en, commonEn)
  const id = SessionId('budget-render')
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Work' }] })
  const node: ChatNode<'turn-request-budget'> = {
    key: 'budget-render', kind: 'turn-request-budget', id: '1', target: 'chat',
    anchorSeq: 5, location: { kind: 'unresolved' }, visibility: 'visible',
    data: {
      kind: 'turn-request-budget', seq: 5, time: 100, turn: 1, step: 1,
      budget: { version: 1, policyId: 'test/ui-budget', actorSessionId: SessionId('budget-child'), rootSessionId: id,
        userMessageId: human.id, actorAttempts: 32, maxAgentAttempts: 32, rootAttempts: 48, maxRootAttempts: 64 },
    },
  }
  const view = render(<TurnRequestBudgetNodeView node={node} t={t} />)
  expect(view.getByRole('status').textContent).toContain('Request limit reached — automatic work paused')
  expect(view.getByRole('status').textContent).toContain('This agent: 32/32 requests; whole task: 48/64 requests.')
  expect(view.getByRole('status').textContent).toContain('requests. Prior work')
  expect(view.getByRole('status').textContent).toContain('Send an explicit follow-up in the root conversation')
  expect(view.queryByText('This turn failed')).toBeNull()
  expect(view.queryByRole('button')).toBeNull()
})

it.each([
  { actorAttempts: 128, rootAttempts: 128, expected: 'This agent: 128/128 requests; whole task: 128/128 requests.' },
  { actorAttempts: 96, rootAttempts: 128, expected: 'This agent: 96/128 requests; whole task: 128/128 requests.' },
  { actorAttempts: 32, rootAttempts: 32, expected: 'This agent: 32/32 requests; whole task: 32/128 requests.' },
])('preserves the effective root ceiling for retained usage $actorAttempts/$rootAttempts', ({ actorAttempts, rootAttempts, expected }) => {
  onTestFinished(cleanup)
  const id = SessionId('budget-root')
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Work' }] })
  const node: ChatNode<'turn-request-budget'> = {
    key: 'budget-root', kind: 'turn-request-budget', id: '1', target: 'chat',
    anchorSeq: 5, location: { kind: 'unresolved' }, visibility: 'visible',
    data: {
      kind: 'turn-request-budget', seq: 5, time: 100, turn: 1, step: 1,
      budget: { version: 1, policyId: 'test/ui-budget', actorSessionId: id, rootSessionId: id,
        userMessageId: human.id, actorAttempts, maxAgentAttempts: 32, rootAttempts, maxRootAttempts: 128 },
    },
  }
  const view = render(<TurnRequestBudgetNodeView node={node} t={makeTranslate(en, commonEn)} />)
  expect(view.getByRole('status').textContent).toContain(expected)
})
