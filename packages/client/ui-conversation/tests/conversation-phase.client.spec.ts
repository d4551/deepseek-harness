import { sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it } from 'vitest'
import { conversationPhase, EMPTY_CONVERSATION_SNAPSHOT } from '../src/client/contract/snapshot.ts'

it('starts with no registered target views or active target identities', () => {
  expect(EMPTY_CONVERSATION_SNAPSHOT.views.get('chat')).toBeUndefined()
  expect(EMPTY_CONVERSATION_SNAPSHOT.views.get('trajectory')).toBeUndefined()
  expect([...EMPTY_CONVERSATION_SNAPSHOT.activeTargets]).toEqual([])
})

it.each([
  { name: 'untouched empty session', blank: true, awaitingFirstTurn: true, promptAttempted: false, running: false, target: false, expected: 'blank' },
  { name: 'attempted prompt awaiting its first turn', blank: true, awaitingFirstTurn: true, promptAttempted: true, running: false, target: false, expected: 'engaging' },
  { name: 'failed attempt before any conversation content', blank: true, awaitingFirstTurn: false, promptAttempted: true, running: false, target: false, expected: 'engaging' },
  { name: 'restored idle conversation', blank: false, awaitingFirstTurn: false, promptAttempted: false, running: false, target: false, expected: 'active' },
  { name: 'running first turn before target content arrives', blank: true, awaitingFirstTurn: true, promptAttempted: true, running: true, target: false, expected: 'active' },
  { name: 'target activity before the session lifecycle catches up', blank: true, awaitingFirstTurn: true, promptAttempted: false, running: false, target: true, expected: 'active' },
  { name: 'nonblank snapshot still waiting for the first accepted turn', blank: false, awaitingFirstTurn: true, promptAttempted: true, running: false, target: false, expected: 'engaging' },
])('derives the shell phase for $name', ({ blank, awaitingFirstTurn, promptAttempted, running, target, expected }) => {
  const session = { ...sessionSnapshot(SessionId('phase-session')), blank, awaitingFirstTurn, promptAttempted, running }
  const conversation = {
    ...EMPTY_CONVERSATION_SNAPSHOT,
    activeTargets: new Set(target ? ['trajectory'] : []),
  }
  expect(conversationPhase(session, conversation)).toBe(expected)
})
