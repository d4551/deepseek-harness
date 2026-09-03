/** Package-owned hook invocation/result stream invariants. @module @deepseek-ai/dsh-hook-protocol/invariant */

import type { Context } from '@deepseek-ai/cordis'
import { advanceOpenTurn, stageSessionEvents } from '@deepseek-ai/dsh-session/invariant-staging'
import type { OpenTurnCursor } from '@deepseek-ai/dsh-session/invariant-staging'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-hook-protocol'

/** Cordis companion plugin name. */
export const name = 'hook-protocol-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

interface HookTransition {
  key: string
  delta: 1 | -1
}

interface HookTrace extends OpenTurnCursor {
  pending: Map<string, number>
}

/** Correlation key shared by an invoked/result pair. */
function hookKey(data: { turn: number; point: string; handlerId: string }): string {
  return `${data.turn}\0${data.point}\0${data.handlerId}`
}

/** Whether this package owns the candidate Session event. */
function isHookPairEvent(event: SessionEvent): event is SessionEvent<'hook/invoked' | 'hook/result'> {
  return event.type === 'hook/invoked' || event.type === 'hook/result'
}

/** Validate one hook event against committed pending invocations. */
function validateHookEvent(
  trace: HookTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): HookTransition | undefined {
  if (!isHookPairEvent(event)) return undefined
  if (trace.openTurn === null) fail(`${event.type} appended outside any open turn`)
  if (event.data.turn !== trace.openTurn) {
    fail(`${event.type} names turn ${event.data.turn} but open turn is ${trace.openTurn}`)
  }
  if (event.type === 'hook/invoked') {
    if (event.data.point.length === 0 || event.data.handlerId.length === 0) {
      fail('hook/invoked point and handlerId must be non-empty')
    }
    const dialect: string = event.data.dialect
    if (dialect !== 'claude-code' && dialect !== 'codex') {
      fail(`hook/invoked carries unknown dialect ${JSON.stringify(dialect)}`)
    }
    return { key: hookKey(event.data), delta: 1 }
  }
  const key = hookKey(event.data)
  if ((trace.pending.get(key) ?? 0) === 0) {
    fail(`hook/result has no matching hook/invoked for ${JSON.stringify(event.data.handlerId)}`)
  }
  if (!Number.isFinite(event.data.durationMs) || event.data.durationMs < 0) {
    fail('hook/result durationMs must be a non-negative finite number')
  }
  return { key, delta: -1 }
}

/** Apply one committed hook-pair transition. */
function applyHookTransition(trace: HookTrace, transition: HookTransition): HookTrace {
  const next = (trace.pending.get(transition.key) ?? 0) + transition.delta
  if (next === 0) trace.pending.delete(transition.key)
  else trace.pending.set(transition.key, next)
  return trace
}

/** Install hook invoked/result pairing checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  stageSessionEvents<HookTrace, HookTransition>(ctx, fail, {
    seed: (session) => {
      const trace: HookTrace = { openTurn: null, pending: new Map() }
      for (const event of session.events) {
        advanceOpenTurn(trace, event)
        const transition = validateHookEvent(trace, event, fail)
        if (transition !== undefined) applyHookTransition(trace, transition)
      }
      return trace
    },
    publish: advanceOpenTurn,
    stage: (trace, event) => validateHookEvent(trace, event, fail),
    claims: isHookPairEvent,
    commit: applyHookTransition,
    unstagedMessage: 'hook event published without pre-commit validation',
  })
}, { inject: ['sessions'] })

/**
 * Register the hook-protocol invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
