/**
 * Settlement helpers for pending-interaction domains: the one-shot composer
 * settle guard and the publish/await/delegate lifecycle every domain runs
 * around {@link PendingInteractionPublisher}.
 * @module @deepseek-ai/dsh-client-ui-session/src/client/pending-settlement
 */

import type { PendingInteractionPublisher, SessionPendingInteractionBase } from './index.ts'

/**
 * Report a composer settlement as a rejected promise instead of a throw, so a
 * double answer surfaces to the caller awaiting the answer rather than to the
 * React event handler that triggered it.
 * @param settle - one-shot settlement the presentation performs.
 * @param failureMessage - message wrapping a non-Error throw.
 * @returns a promise resolved once settled, rejected with the failure otherwise.
 */
export function settlePendingComposer(settle: () => void, failureMessage: string): Promise<void> {
  try {
    settle()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error
      ? error
      : new Error(failureMessage, { cause: error }))
  }
}

/** A pending presentation that can hand its request back to the Host waterfall. */
export interface DelegatablePendingInteraction<Outcome> {
  /** Result returned to the waiting Host listener. */
  readonly result: Promise<Outcome>
  /** Reject {@link DelegatablePendingInteraction.result} with the delegation marker. */
  delegate: () => void
  /**
   * Test whether a rejection requests waterfall delegation.
   * @param reason - rejection received from `result`.
   * @returns whether `delegate` produced it.
   */
  isDelegation: (reason: unknown) => boolean
}

/**
 * Publish one pending interaction and settle it: the user's answer wins, a
 * delegation resumes the Host waterfall, and any other rejection propagates.
 * Teardown delegates first and only completes once this call has removed the
 * publication, which keeps the domain quiescent before its owner disposes.
 * @param pending - the answerable presentation to publish.
 * @param publish - the domain's publisher from `uiSession.registerPendingInteraction`.
 * @param delegated - continuation producing the outcome when the request is delegated.
 * @returns the answered or delegated outcome.
 */
export async function settlePendingInteraction<
  Outcome,
  Pending extends SessionPendingInteractionBase & DelegatablePendingInteraction<Outcome>,
>(
  pending: Pending,
  publish: PendingInteractionPublisher<Pending>,
  delegated: () => Promise<Outcome>,
): Promise<Outcome> {
  const completed = Promise.withResolvers<void>()
  const remove = publish(pending, async () => {
    pending.delegate()
    await completed.promise
  })
  try {
    try {
      return await pending.result
    } catch (error) {
      if (pending.isDelegation(error)) return await delegated()
      throw error
    }
  } finally {
    remove()
    completed.resolve()
  }
}
