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

/**
 * Count still-unmatched approval questions after replaying `events`.
 * @param events - committed session log prefix to fold.
 * @returns ids of `approval/asked` events without their `approval/decided`.
 */
function openQuestionIds(events: readonly SessionEvent[]): Set<string> {
  const open = new Set<string>()
  for (const event of events) {
    if (event.type === 'approval/asked') open.add(event.data.id)
    else if (event.type === 'approval/decided') open.delete(event.data.id)
  }
  return open
}

/** Whether one session event is a user message injected by this plugin. */
function isAssessorInjection(event: SessionEvent): boolean {
  if (event.type !== 'user/message') return false
  const origin = (event.data as { source?: { kind?: string; plugin?: string } }).source
  return origin?.kind === 'plugin' && origin.plugin === 'approval-assessor'
}

/**
 * Install the injection-window invariant: every user message this plugin
 * injects must be appended while an approval question is still pending in
 * the same session, because the injection is the assessor's rejection
 * context for that question.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!isAssessorInjection(event)) return
    if (openQuestionIds(session.events).size === 0) {
      fail('approval-assessor injected a user message with no pending approval question')
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
