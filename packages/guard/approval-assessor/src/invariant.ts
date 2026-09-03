/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-approval-assessor`.
 * @module @deepseek-ai/dsh-approval-assessor/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-approval-assessor'

/** Cordis companion plugin name. */
export const name = 'approval-assessor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Whether one session event is a user message this plugin authored. */
function isAssessorRedirect(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const origin = (event.data as { source?: { kind?: string; plugin?: string } }).source
  return origin?.kind === 'plugin' && origin.plugin === 'approval-assessor'
}

/** Redirects this plugin has already committed, and rejections available to explain them. */
interface RedirectBalance {
  /** Committed `user/message` events this plugin authored. */
  redirects: number
  /** Committed `approval/decided` events whose outcome was `rejected`. */
  rejections: number
}

/**
 * Fold the committed prefix into the counts the relation compares.
 * @param events - committed session log prefix to fold.
 * @returns the redirect and rejection counts.
 */
function balance(events: readonly SessionEvent[]): RedirectBalance {
  const counts: RedirectBalance = { redirects: 0, rejections: 0 }
  for (const event of events) {
    if (isAssessorRedirect(event)) counts.redirects += 1
    else if (event.type === 'approval/decided' && event.data.outcome === 'rejected') counts.rejections += 1
  }
  return counts
}

/**
 * Install the redirect-accounting invariant: this plugin appends one redirect
 * for each approval it rejects, so the redirects committed to a session never
 * outnumber that session's rejected approval decisions. A redirect with no
 * rejection behind it is a message the model was given without the denial it
 * explains.
 *
 * The redirect reaches the log through the agent inbox, one step after the
 * decision, so the window is the whole session rather than the span of a
 * single open question.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  // internal/dispatch rejects the append before publication; a session/event
  // listener runs after the commit, where `Session.append` contains a throw
  // into a logger warning and the offending message stays in the log.
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (!isAssessorRedirect(event)) return
    // The candidate is not committed yet, so it is counted here rather than folded.
    const { redirects, rejections } = balance(session.events)
    if (redirects + 1 > rejections) {
      fail(`approval-assessor redirect ${String(redirects + 1)} has no rejected approval decision behind it (${String(rejections)} recorded)`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
