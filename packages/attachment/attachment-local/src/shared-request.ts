/** Shared image work whose final cancelling caller owns settlement. */

import { addAbortListener } from 'node:events'

/** One transform shared only while callers retain an interest in its result. */
export class SharedRequest<T> {
  /** Shared cancellation controller; the final cancelling waiter requests termination. */
  readonly controller = new AbortController()
  /** Owned operation and settlement bookkeeping, joined by the final cancelling waiter. */
  readonly promise: Promise<T>
  private settled = false
  private waiters = 0

  /**
   * @param start - operation that retains native resources until its promise settles.
   */
  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  /**
   * Join the operation without letting one caller cancel another's work.
   * @param signal - caller cancellation; the last cancelling caller waits for shared settlement.
   * @returns the shared result, or rejection with the caller's exact cancellation reason.
   */
  async wait(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    this.waiters += 1
    let released = false
    const release = (cancelled: boolean): void => {
      if (released) return
      released = true
      this.waiters -= 1
      if (cancelled && this.waiters === 0 && !this.settled && signal !== undefined) {
        const reason: unknown = signal.reason
        this.controller.abort(reason)
      }
    }
    const cancelled = Promise.withResolvers<undefined>()
    const cancellation = signal === undefined ? undefined : addAbortListener(signal, () => {
      release(true)
      cancelled.resolve(undefined)
    })
    try {
      await Promise.race([this.promise, cancelled.promise])
      signal?.throwIfAborted()
      return await this.promise
    } finally {
      cancellation?.[Symbol.dispose]()
      release(false)
      if (this.controller.signal.aborted) await Promise.allSettled([this.promise])
      signal?.throwIfAborted()
    }
  }
}
