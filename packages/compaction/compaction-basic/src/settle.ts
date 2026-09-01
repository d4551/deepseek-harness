/**
 * Single-promise settlement as a typed result. One await of this helper
 * observes both outcomes of one promise without an indexed-array guard and
 * without a `catch` construct.
 *
 * @module @deepseek-ai/dsh-compaction-basic/settle
 */

/**
 * One settled outcome of a single promise. A rejection carries `unknown`,
 * because a thrown value is unconstrained at the promise boundary.
 */
export type SettledOne<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }

/**
 * Settle one promise into a discriminated result, so both the fulfilled
 * value and the rejection reason surface as data instead of control flow.
 * @param promise - the single promise to settle.
 * @returns the fulfilled value or the rejection reason, discriminated by `status`.
 */
export function settleOne<T>(promise: Promise<T>): Promise<SettledOne<T>> {
  return promise.then(
    (value): SettledOne<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): SettledOne<T> => ({ status: 'rejected', reason }),
  )
}

/**
 * Run one operation inside the promise boundary and settle its outcome, so a
 * synchronous throw from `operation` becomes a rejection instead of escaping
 * the caller.
 * @param operation - the call to run and settle.
 * @returns the fulfilled value or the rejection reason, discriminated by `status`.
 */
export function settleCall<T>(operation: () => T | PromiseLike<T>): Promise<SettledOne<T>> {
  return settleOne(Promise.resolve().then(operation))
}
