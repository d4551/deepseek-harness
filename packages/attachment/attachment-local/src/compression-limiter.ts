/** Instance-owned concurrency bound for native image transformations. */

import { addAbortListener } from 'node:events'

/** FIFO limiter for asynchronous compression work. */
export class CompressionLimiter {
  private active = 0
  private readonly waiting = new Set<() => void>()

  /**
   * @param concurrency - positive maximum number of active tasks.
   */
  constructor(readonly concurrency: number) {}

  /**
   * Run one task after an instance slot becomes available.
   * @param task - compression operation occupying one slot until settlement.
   * @param signal - cancellation removes queued work; active work retains its slot until settlement.
   * @returns the task result after cancellation is checked, preserving operation failures.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const ready = Promise.withResolvers<boolean>()
    const start = (): void => {
      this.active += 1
      ready.resolve(true)
    }
    const cancellation = signal === undefined ? undefined : addAbortListener(signal, () => {
      if (this.waiting.delete(start)) ready.resolve(false)
    })
    if (this.active < this.concurrency) start()
    else this.waiting.add(start)
    const acquired = await ready.promise
    try {
      signal?.throwIfAborted()
      const value = await task()
      signal?.throwIfAborted()
      return value
    } finally {
      cancellation?.[Symbol.dispose]()
      if (acquired) {
        this.active -= 1
        const next = this.waiting.values().next().value
        if (next !== undefined) {
          this.waiting.delete(next)
          next()
        }
      }
    }
  }
}
