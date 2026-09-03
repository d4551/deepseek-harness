/**
 * Per-key operation serialization.
 *
 * A filesystem backend must not run two mutations against one target at the
 * same time: a read-modify-write pair that interleaves loses one of the two
 * writes. Callers hold no lock object — they name the key, and the queue for
 * that key is created on first use and dropped when it drains, so a process
 * that touches many keys once retains nothing.
 *
 * @module @deepseek-ai/dsh-keyed-lock
 */

/** Serializes operations per key, retaining a queue only while one is in flight. */
export class KeyedLock {
  private readonly queues = new Map<string, Promise<void>>()

  /**
   * Run `operation` once every earlier operation for `key` has settled.
   *
   * Ordering is arrival order. A rejected operation does not stall the key: the
   * next caller runs regardless, and the rejection reaches only its own caller.
   * @param key - the identity whose operations are serialized.
   * @param operation - the work to run while holding the key.
   * @returns whatever `operation` resolves to.
   * @throws whatever `operation` rejects with, unchanged.
   */
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve()
    const active = prior.then(operation, operation)
    // The tail absorbs the outcome so a rejection never propagates to the next
    // caller, and so an unobserved rejection cannot escape as an unhandled one.
    const tail = active.then(() => undefined, () => undefined)
    this.queues.set(key, tail)
    try {
      return await active
    } finally {
      // Only the newest waiter clears the key; an older tail settling later
      // would otherwise drop a queue that a newer caller is still standing in.
      if (this.queues.get(key) === tail) this.queues.delete(key)
    }
  }

  /**
   * How many keys currently have an operation in flight or queued.
   * @returns the retained key count.
   */
  get size(): number {
    return this.queues.size
  }
}
