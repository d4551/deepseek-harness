/** Package-owned approval audit-stream invariants. @module @deepseek-ai/dsh-user-approval/invariant */

import type { Context } from '@deepseek-ai/cordis'
import { advanceOpenTurn, stageSessionEvents } from '@deepseek-ai/dsh-session/invariant-staging'
import type { OpenTurnCursor } from '@deepseek-ai/dsh-session/invariant-staging'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ApprovalRequestId } from './index.ts'
import { APPROVAL_POLICIES } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-approval'
const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const

/** Cordis companion plugin name. */
export const name = 'user-approval-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

type ApprovalTransition =
  | { kind: 'asked'; id: ApprovalRequestId }
  | { kind: 'decided'; id: ApprovalRequestId }

interface ApprovalTrace extends OpenTurnCursor {
  pending: Set<ApprovalRequestId>
}

/** Whether this package owns the candidate Session event. */
function isApprovalPairEvent(event: SessionEvent): boolean {
  return event.type === 'approval/asked' || event.type === 'approval/decided'
}

/** Validate one approval event against committed unmatched questions. */
function validateApprovalEvent(
  trace: ApprovalTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): ApprovalTransition | undefined {
  if (event.type === 'approval/asked') {
    if (trace.openTurn === null) fail('approval/asked appended outside any open turn')
    if (event.data.toolName.length === 0) fail('approval/asked toolName must be non-empty')
    if (trace.pending.has(event.data.id)) fail(`approval/asked repeated open id ${JSON.stringify(event.data.id)}`)
    return { kind: 'asked', id: event.data.id }
  }
  if (event.type === 'approval/decided') {
    if (trace.openTurn === null) fail('approval/decided appended outside any open turn')
    if (!trace.pending.has(event.data.id)) fail(`approval/decided has no matching approval/asked for id ${JSON.stringify(event.data.id)}`)
    if (!APPROVAL_OUTCOMES.includes(event.data.outcome)) {
      fail(`approval/decided carries unknown outcome ${JSON.stringify(event.data.outcome)}`)
    }
    return { kind: 'decided', id: event.data.id }
  }
  if (event.type === 'approval/policy' && !APPROVAL_POLICIES.includes(event.data.policy)) {
    fail(`approval/policy carries unknown policy ${JSON.stringify(event.data.policy)}`)
  }
  return undefined
}

/** Apply one accepted approval-pair transition. */
function applyApprovalTransition(trace: ApprovalTrace, transition: ApprovalTransition): ApprovalTrace {
  if (transition.kind === 'asked') trace.pending.add(transition.id)
  else trace.pending.delete(transition.id)
  return trace
}

/** Install audit pairing and closed-vocabulary checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  stageSessionEvents<ApprovalTrace, ApprovalTransition>(ctx, fail, {
    seed: (session) => {
      const trace: ApprovalTrace = { openTurn: null, pending: new Set() }
      for (const event of session.events) {
        advanceOpenTurn(trace, event)
        const transition = validateApprovalEvent(trace, event, fail)
        if (transition !== undefined) applyApprovalTransition(trace, transition)
      }
      return trace
    },
    publish: advanceOpenTurn,
    stage: (trace, event) => validateApprovalEvent(trace, event, fail),
    claims: isApprovalPairEvent,
    commit: applyApprovalTransition,
    unstagedMessage: 'approval audit event published without pre-commit validation',
  })
}, { inject: ['sessions'] })

/**
 * Register the approval invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
