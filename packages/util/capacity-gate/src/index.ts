/**
 * Zero-dependency FIFO admission control: bound how many operations a holder
 * runs at once, admit queued callers in arrival order, and release each granted
 * slot exactly once.
 *
 * The gate only delays an acquisition. It never cancels, settles, or cleans up
 * the work a caller runs under the slot, so two operations sharing one gate keep
 * independent settlement: the holder releases its own slot on every terminal
 * path, and a waiter that never runs consumes nothing.
 *
 * Cancellation has two sources with different scope. A per-acquisition
 * `AbortSignal` rejects that one waiter; {@link CapacityGate.close} rejects every
 * queued waiter and refuses later acquisitions, which is what a disposing holder
 * needs so a queued caller fails instead of hanging.
 *
 * @module @deepseek-ai/dsh-capacity-gate
 */

/**
 * Release one granted slot. Idempotent: the first call returns the slot and
 * admits the next waiter, and later calls do nothing, so a holder may release
 * from several terminal paths without double-counting.
 */
export type CapacityRelease = () => void

/** Point-in-time admission state of one gate. */
export interface CapacitySnapshot {
  /** Concurrent grants this gate allows. */
  readonly limit: number
  /** Granted slots not yet released. */
  readonly active: number
  /** Acquisitions queued behind the limit, in admission order. */
  readonly waiting: number
}

/** One queued acquisition and the two ways it can leave the queue. */
interface CapacityWaiter {
  /** Hand this waiter the slot the releasing holder just returned. */
  grant(): void
  /** Reject this waiter without granting a slot. */
  fail(error: Error): void
}

/**
 * Bounded FIFO admission controller shared by capability holders that must cap
 * concurrent work without coupling the settlement of the operations they admit.
 */
export class CapacityGate {
  private activeSlots = 0
  private readonly waiters: CapacityWaiter[] = []
  private closure: { readonly error: Error } | undefined

  /**
   * @param limit - concurrent grants this gate allows; a positive safe integer.
   * @throws {RangeError} when `limit` is not a positive safe integer.
   */
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`capacity gate limit must be a positive safe integer, received ${String(limit)}`)
    }
  }

  /**
   * Read the current admission state.
   * @returns the configured limit, the granted-and-unreleased count, and the queue length.
   */
  snapshot(): CapacitySnapshot {
    return { limit: this.limit, active: this.activeSlots, waiting: this.waiters.length }
  }

  /**
   * Take one slot only while the gate is below its bound, without waiting and
   * without yielding to the event loop. A holder uses this first so that the
   * unsaturated path keeps the exact timing it had before the gate existed:
   * whatever the holder does next still runs in its caller's own tick.
   * @returns the idempotent release for the granted slot, or undefined when the
   *   gate is full or closed and the caller must {@link acquire} instead.
   */
  tryAcquire(): CapacityRelease | undefined {
    if (this.closure !== undefined || this.activeSlots >= this.limit) return undefined
    this.activeSlots += 1
    return this.releaser()
  }

  /**
   * Take one slot, queueing in arrival order while the gate is full.
   *
   * `signal` governs the wait alone. A gate with a free slot grants it without
   * reading the signal, so a holder that is not at its bound behaves exactly as
   * it would with no gate and keeps its own pre-flight cancellation rule. Once
   * the gate is full, an already-aborted or later-aborted caller rejects with
   * `signal.reason` and holds no slot.
   * @param signal - optional caller cancellation covering the wait only.
   * @returns the idempotent release for the granted slot.
   * @throws `signal.reason` when the caller cancels while queued, or the
   *   {@link close} error when the gate closed before or during the wait.
   */
  async acquire(signal?: AbortSignal): Promise<CapacityRelease> {
    if (this.closure !== undefined) throw this.closure.error
    if (this.activeSlots < this.limit) {
      this.activeSlots += 1
    } else {
      signal?.throwIfAborted()
      await this.enqueue(signal)
      // A release and an abort can land in the same tick: the grant already
      // took the slot, so hand it to the next waiter rather than running work
      // this caller cancelled.
      if (signal?.aborted === true) {
        this.handOff()
        signal.throwIfAborted()
      }
    }
    return this.releaser()
  }

  /**
   * Reject every queued waiter and refuse later acquisitions. Granted slots stay
   * with their holders, whose releases remain safe no-ops for the queue.
   * Idempotent; the first closure error is the one every caller sees.
   * @param error - the failure queued and later callers reject with.
   */
  close(error: Error): void {
    this.closure ??= { error }
    for (const waiter of this.waiters.splice(0)) waiter.fail(this.closure.error)
  }

  /** Queue one acquisition until a release grants it, the caller aborts, or the gate closes. */
  private enqueue(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const leave = (): boolean => {
        if (settled) return false
        settled = true
        signal?.removeEventListener('abort', onAbort)
        return true
      }
      const waiter: CapacityWaiter = {
        grant: () => {
          /* v8 ignore next -- the queue drops a waiter before failing it, so no waiter is settled twice. */
          if (!leave()) return
          this.activeSlots += 1
          resolve()
        },
        fail: (error: Error) => {
          /* v8 ignore next -- close() splices the queue, so a failed waiter is never also granted. */
          if (!leave()) return
          reject(error)
        },
      }
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter)
        // A granted waiter already left the queue and owns its slot; the
        // post-grant abort check hands that slot on.
        if (index < 0) return
        this.waiters.splice(index, 1)
        const abortReason = signal?.reason
        const reason: Error = abortReason instanceof Error ? abortReason : new Error(String(abortReason))
        waiter.fail(reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Build the idempotent release for one granted slot. */
  private releaser(): CapacityRelease {
    let released = false
    return () => {
      if (released) return
      released = true
      this.handOff()
    }
  }

  /** Return one slot and grant it to the longest-waiting acquisition, when any. */
  private handOff(): void {
    this.activeSlots -= 1
    this.waiters.shift()?.grant()
  }
}
