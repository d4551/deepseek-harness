/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-approval-adversary`.
 * @module @deepseek-ai/dsh-approval-adversary/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-approval-adversary'
const PLUGIN = 'approval-adversary'
const ALLOWED_SUMMARY = 'adversarial review: allowed'

/** Cordis companion plugin name. */
export const name = 'approval-adversary-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The verdict class a notice this plugin authored reports, or undefined for a foreign event. */
function noticeClass(event: SessionEvent): 'allowed' | 'rejected' | undefined {
  if (event.type !== 'user/message') return undefined
  const origin = (event.data as { source?: { kind?: string; plugin?: string; summary?: string } }).source
  if (origin?.kind !== 'plugin' || origin.plugin !== PLUGIN) return undefined
  return origin.summary === ALLOWED_SUMMARY ? 'allowed' : 'rejected'
}

/** Notices this plugin has committed, and the decisions available to explain them. */
interface VerdictBalance {
  /** Committed allowed notices. */
  allowedNotices: number
  /** Committed denied and unavailable notices. */
  rejectedNotices: number
  /** Committed `approval/decided` events whose outcome was `allowed-once`. */
  grants: number
  /** Committed `approval/decided` events whose outcome was `rejected`. */
  rejections: number
}

/**
 * Fold the committed prefix into the counts the relation compares.
 * @param events - committed session log prefix to fold.
 * @returns the notice and decision counts.
 */
function balance(events: readonly SessionEvent[]): VerdictBalance {
  const counts: VerdictBalance = { allowedNotices: 0, rejectedNotices: 0, grants: 0, rejections: 0 }
  for (const event of events) {
    const notice = noticeClass(event)
    if (notice === 'allowed') counts.allowedNotices += 1
    else if (notice === 'rejected') counts.rejectedNotices += 1
    else if (event.type === 'approval/decided') {
      if (event.data.outcome === 'allowed-once') counts.grants += 1
      else if (event.data.outcome === 'rejected') counts.rejections += 1
    }
  }
  return counts
}

/**
 * Install the verdict-accounting invariant: this plugin appends one notice per
 * verdict it produced, so a session's allowed notices never outnumber its
 * granted approval decisions and its denied plus unavailable notices never
 * outnumber its rejected ones. A notice with no matching decision behind it
 * reports a verdict the approval service never recorded.
 *
 * The notice reaches the log through the agent inbox, one step after the
 * decision, so the window is the whole session rather than one open question.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  // internal/dispatch rejects the append before publication; a session/event
  // listener runs after the commit, where `Session.append` contains a throw
  // into a logger warning and the offending message stays in the log.
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const notice = noticeClass(event)
    if (notice === undefined) return
    // The candidate is not committed yet, so it is counted here rather than folded.
    const counts = balance(session.events)
    if (notice === 'allowed' && counts.allowedNotices + 1 > counts.grants) {
      fail(`approval-adversary allowed notice ${String(counts.allowedNotices + 1)} has no granted approval decision behind it (${String(counts.grants)} recorded)`)
    }
    if (notice === 'rejected' && counts.rejectedNotices + 1 > counts.rejections) {
      fail(`approval-adversary rejection notice ${String(counts.rejectedNotices + 1)} has no rejected approval decision behind it (${String(counts.rejections)} recorded)`)
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
