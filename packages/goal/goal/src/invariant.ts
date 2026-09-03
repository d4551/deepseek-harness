/** Package-owned durable goal-stream invariants. @module @deepseek-ai/dsh-goal/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { stageSessionEvents } from '@deepseek-ai/dsh-session/invariant-staging'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyGoalEvent, emptyGoalFoldState } from './fold.ts'
import type { GoalFoldState } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-goal'

/** Cordis companion plugin name. */
export const name = 'goal-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Copy the independent fold before validating one candidate event. */
function cloneState(state: GoalFoldState): GoalFoldState {
  return {
    goal: state.goal,
    roundsStarted: state.roundsStarted,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    lastRef: state.lastRef,
    seenGoalIds: new Set(state.seenGoalIds),
  }
}

/** Apply one event through the strict goal decoder and attribute failures. */
function applyChecked(state: GoalFoldState, event: SessionEvent, fail: InvariantFailure): void {
  try {
    applyGoalEvent(state, event)
  } catch (error) {
    /* v8 ignore next -- the strict goal decoder throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    fail(`session event ${event.seq} violates the durable goal stream: ${message}`)
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  stageSessionEvents<GoalFoldState, GoalFoldState>(ctx, fail, {
    seed: (session) => {
      const state = emptyGoalFoldState()
      for (const event of session.events) applyChecked(state, event, fail)
      return state
    },
    stage: (state, event) => {
      const candidate = cloneState(state)
      applyChecked(candidate, event, fail)
      return candidate
    },
    claims: () => true,
    commit: (_state, candidate) => candidate,
    unstagedMessage: 'session/event reached publication without matching goal-fold validation',
  })
}, { inject: ['sessions'] })

/**
 * Register the goal-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
