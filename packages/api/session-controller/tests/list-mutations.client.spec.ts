import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '../src/types.ts'
import { applySessionListMutation } from '../src/client/sessions/list-mutations.ts'

it.each([
  { existingBlank: true, arrivingBlank: true, expectedBlank: true },
  { existingBlank: true, arrivingBlank: false, expectedBlank: false },
  { existingBlank: false, arrivingBlank: true, expectedBlank: false },
  { existingBlank: false, arrivingBlank: false, expectedBlank: false },
])('retains conversation engagement across repeated additions: $existingBlank, $arrivingBlank', ({
  existingBlank, arrivingBlank, expectedBlank,
}) => {
  const sessionId = SessionId('conversation')
  const current: SessionSummary = { sessionId, updatedAt: 4, running: false, blank: existingBlank }
  const result = applySessionListMutation([current], {
    kind: 'upsert',
    summary: { sessionId, updatedAt: 1, running: false, blank: arrivingBlank },
  })
  expect(result).toEqual([{ sessionId, updatedAt: 4, running: false, blank: expectedBlank }])
  expect(current.blank).toBe(existingBlank)
})

it('fills missing workspace and lineage without replacing established session identity', () => {
  const sessionId = SessionId('worker')
  const parentSessionId = SessionId('parent')
  const initial: SessionSummary = { sessionId, updatedAt: 4, running: true, blank: false }
  const enriched = applySessionListMutation([initial], {
    kind: 'upsert',
    summary: {
      sessionId, updatedAt: 1, running: false, blank: true,
      cwd: '/workspace/one', parentSessionId, origin: 'subagent',
    },
  })
  expect(enriched).toEqual([{
    sessionId, updatedAt: 4, running: true, blank: false,
    cwd: '/workspace/one', parentSessionId, origin: 'subagent',
  }])
  const repeated = applySessionListMutation(enriched, {
    kind: 'upsert',
    summary: {
      sessionId, updatedAt: 2, running: false, blank: true,
      cwd: '/workspace/two', parentSessionId: SessionId('different-parent'),
    },
  })
  expect(repeated).toEqual(enriched)
  expect(repeated).toBe(enriched)
})

it('keeps incomplete repeated additions from erasing known workspace and lineage', () => {
  const summary: SessionSummary = {
    sessionId: SessionId('known-worker'), updatedAt: 4, running: false, blank: false,
    cwd: '/workspace/one', parentSessionId: SessionId('parent'), origin: 'subagent',
  }
  const summaries = [summary]
  const result = applySessionListMutation(summaries, {
    kind: 'upsert',
    summary: { sessionId: summary.sessionId, updatedAt: 1, running: false, blank: true },
  })
  expect(result).toEqual([summary])
  expect(result).toBe(summaries)
})
