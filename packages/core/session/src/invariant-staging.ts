/**
 * Pre-commit staging shared by package-owned invariant companions that fold a
 * relation over the session event log.
 *
 * `Session.append` resolves its `session/event` listeners — which emits
 * `internal/dispatch` — before pushing the event, and calls them after. A
 * companion therefore validates a candidate during dispatch, where throwing
 * rejects the append, and folds the accepted result during publication, where
 * the event is already committed. Every owner needs the same plumbing for that
 * split: per-session committed state, a staging table keyed by the exact event
 * object, and adoption of a session first seen at dispatch.
 *
 * Owners keep their own relation: `stage` validates, `commit` folds, and
 * `claims` decides which published events must have been staged, so a
 * publication path that skipped dispatch fails instead of committing silently.
 *
 * @module @deepseek-ai/dsh-session/invariant-staging
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure } from '@deepseek-ai/dsh-invariants'
import type { Session } from './index.ts'
import type { SessionEvent } from './types.ts'

/** Per-session state holding the turn `turn/start` opened and `turn/end` closed. */
export interface OpenTurnCursor {
  /** The open turn number, or null between turns. */
  openTurn: number | null
}

/**
 * Move an open-turn cursor across one session event.
 * @param cursor - the cursor to advance in place.
 * @param event - the replayed or published event.
 * @returns whether the event was a turn boundary, which carries no other relation.
 */
export function advanceOpenTurn(cursor: OpenTurnCursor, event: SessionEvent): boolean {
  if (event.type === 'turn/start') {
    cursor.openTurn = event.data.turn
    return true
  }
  if (event.type === 'turn/end') {
    cursor.openTurn = null
    return true
  }
  return false
}

/**
 * One package's relation over the session event log, split into the steps
 * {@link stageSessionEvents} drives.
 *
 * @typeParam TState - the owner's committed per-session state, an object so a
 * seeded session is distinguishable from one never seen.
 * @typeParam TStaged - what one validated candidate carries to its commit.
 */
export interface SessionEventStaging<TState extends object, TStaged> {
  /**
   * Build committed state from the events a session already holds. Reported
   * failures reject the companion's own registration rather than an append.
   * @param session - the session whose durable prefix seeds the state.
   * @returns the committed state for that session.
   */
  seed(session: Session): TState
  /**
   * Advance state that publication commits directly, without a staged result.
   * Runs before {@link claims} so a cursor still moves on unclaimed events.
   * @param state - the session's committed state.
   * @param event - the event that just reached publication.
   * @returns whether the event is fully handled and needs no staged result.
   */
  publish?(state: TState, event: SessionEvent): boolean
  /**
   * Validate one candidate before its append commits. Must leave `state`
   * unchanged: a later dispatch listener may still veto the append.
   * @param state - the session's committed state.
   * @param event - the candidate event.
   * @returns what to commit on publication, or undefined when this owner ignores the event.
   */
  stage(state: TState, event: SessionEvent): TStaged | undefined
  /**
   * Whether a published event must carry a staged result.
   * @param event - the event that reached publication.
   * @returns true when a missing staged result is a violation.
   */
  claims(event: SessionEvent): boolean
  /**
   * Fold one staged result into committed state.
   * @param state - the session's committed state.
   * @param staged - the value {@link stage} produced for this event.
   * @returns the state that becomes committed, which may be `state` itself.
   */
  commit(state: TState, staged: TStaged): TState
  /** Failure reported when a claimed event reaches publication unstaged. */
  readonly unstagedMessage: string
}

/**
 * Drive one package's relation over every session the store owns and every
 * session announced or observed later.
 *
 * The three listeners are `ctx.on` effects on the calling fiber: disposing the
 * invariant registration removes them and abandons the per-session state.
 *
 * @param ctx - the registration's child context, which must inject `sessions`.
 * @param fail - the failure reporter bound to the registering package.
 * @param staging - the owner's seed, validation, and commit steps.
 */
export function stageSessionEvents<TState extends object, TStaged>(
  ctx: Context,
  fail: InvariantFailure,
  staging: SessionEventStaging<TState, TStaged>,
): void {
  const states = new WeakMap<Session, TState>()
  const pending = new WeakMap<SessionEvent, { session: Session; staged: TStaged }>()

  const seed = (session: Session): TState => {
    const state = staging.seed(session)
    states.set(session, state)
    return state
  }
  const stateFor = (session: Session): TState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    // Validation is pure, so abandoning this weakly keyed entry after a later
    // dispatch listener vetoes advances and retains nothing.
    const staged = staging.stage(stateFor(session), event)
    if (staged !== undefined) pending.set(event, { session, staged })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const state = stateFor(session)
    if (staging.publish?.(state, event) === true) return
    if (!staging.claims(event)) return
    const candidate = pending.get(event)
    if (candidate === undefined || candidate.session !== session) return fail(staging.unstagedMessage)
    pending.delete(event)
    states.set(session, staging.commit(state, candidate.staged))
  }, { global: true })
}
