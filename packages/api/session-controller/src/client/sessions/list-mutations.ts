/** Session summary reconciliation for live events and in-flight list replay. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '../../types.ts'

/** One observed change retained while a list request is in flight. */
export type SessionListMutation =
  | { kind: 'upsert'; summary: SessionSummary }
  | { kind: 'remove'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId; running: boolean }
  | { kind: 'activity'; sessionId: SessionId; updatedAt: number }
  | { kind: 'engaged'; sessionId: SessionId }

/**
 * Reconcile a summary change while retaining identity for unchanged lists.
 * @param summaries - latest summaries before the event.
 * @param mutation - observed change or pending event replay.
 * @returns the current list or a new list containing the changed summary.
 */
export function applySessionListMutation(
  summaries: readonly SessionSummary[],
  mutation: SessionListMutation,
): readonly SessionSummary[] {
  const sessionId = mutation.kind === 'upsert' ? mutation.summary.sessionId : mutation.sessionId
  const index = summaries.findIndex(summary => summary.sessionId === sessionId)
  const existing = summaries[index]
  switch (mutation.kind) {
    case 'upsert': {
      if (existing === undefined) return [mutation.summary, ...summaries]
      const filled: SessionSummary = {
        ...existing,
        blank: existing.blank && mutation.summary.blank,
        ...(existing.cwd === undefined && mutation.summary.cwd !== undefined ? { cwd: mutation.summary.cwd } : {}),
        ...(existing.parentSessionId === undefined && mutation.summary.parentSessionId !== undefined
          ? { parentSessionId: mutation.summary.parentSessionId } : {}),
        ...(existing.origin === undefined && mutation.summary.origin !== undefined
          ? { origin: mutation.summary.origin } : {}),
      }
      if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId
        && filled.origin === existing.origin && filled.blank === existing.blank
      ) return summaries
      return summaries.with(index, filled)
    }
    case 'remove':
      return existing === undefined ? summaries : summaries.filter(summary => summary.sessionId !== sessionId)
    case 'status':
      if (existing === undefined
        || (existing.running === mutation.running && !(mutation.running && existing.blank))) return summaries
      return summaries.with(index, {
        ...existing, running: mutation.running, blank: existing.blank && !mutation.running,
      })
    case 'activity':
      if (existing === undefined || !(mutation.updatedAt > existing.updatedAt)) return summaries
      return summaries.with(index, { ...existing, updatedAt: mutation.updatedAt })
    case 'engaged':
      if (existing === undefined || !existing.blank) return summaries
      return summaries.with(index, { ...existing, blank: false })
  }
}
