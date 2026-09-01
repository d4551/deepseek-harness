/**
 * Durable compaction-lock entry state. Reads open-turn, unmatched-compaction,
 * and latest seed-boundary facts from the log and asserts the lock before
 * any compaction entry point appends its own bracket.
 *
 * @module @deepseek-ai/dsh-compaction-basic/lock
 */

import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Lock-relevant log facts at one entry inspection. */
interface CompactionEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  readonly latestEndSeedSeq: number | undefined
}

/**
 * Reject a durable unmatched compaction marker unless a later constructor-seed
 * boundary proves that its owner belongs to an earlier session lifecycle.
 * @param unmatchedCompactionStart - latest unmatched opening marker, if any.
 * @param latestEndSeedSeq - newest constructor-seed boundary, if any.
 * @param stage - operation label included in the busy diagnostic.
 */
export function assertCompactionInactive(
  unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined,
  latestEndSeedSeq: number | undefined,
  stage: string,
): void {
  if (unmatchedCompactionStart === undefined
    || (latestEndSeedSeq !== undefined
      && latestEndSeedSeq > unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError(
    'busy',
    `${stage}: compaction already in progress; the session compaction lock is already active`,
  )
}

/**
 * Recheck the durable compaction lock after an asynchronous policy decision.
 * @param session - session whose latest marker state is inspected.
 * @param stage - operation label included in the busy diagnostic.
 */
export function assertNoActiveCompaction(session: Session, stage: string): void {
  const entryState = inspectCompactionEntryState(session.events)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    stage,
  )
}

/**
 * Inspect open-turn, unmatched-compaction, and latest seed-boundary state.
 * @param events - the session log to scan from its tail.
 * @returns the lock-relevant facts at this entry inspection.
 */
export function inspectCompactionEntryState(events: readonly SessionEvent[]): CompactionEntryState {
  let openTurn: number | undefined
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: number | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    /* v8 ignore next -- the scan walks down from `length - 1`, so every index is in bounds */
    if (event === undefined) {
      throw new Error('compaction: session event missing at the entry-state scan position')
    }
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown
      && compactionEntryStateKnown
      && latestEndSeedSeq !== undefined) break
  }
  return { openTurn: openTurn ?? null, unmatchedCompactionStart, latestEndSeedSeq }
}
