/**
 * One-shot settlement adapter for composer presentations: projects a
 * synchronous settle attempt onto the promise the composer's caller awaits.
 * @module @deepseek-ai/dsh-client-ui-projection/src/pending-composer
 */

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
