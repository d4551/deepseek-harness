/** One-shot Team change waiters independent of durable state projection. */

import type { TeamId, TeamWaitResult } from './types.ts'
import { errorMessage, TeamError } from './error.ts'

interface Waiter {
  readonly resolve: () => void
}

/** Owns current Team change waiters and releases each at most once. */
export class TeamActivity {
  private readonly waiters = new Map<TeamId, Set<Waiter>>()
  private readonly observers = new Map<TeamId, Set<() => void>>()
  private closed = false

  /**
   * Observe an initial revision and coalesced Team changes without polling.
   * @param id - Team whose activity advances this subscription.
   * @param signal - cancellation owned by the Remote stream.
   * @returns subscription-local revisions; intermediate revisions may coalesce.
   */
  changes(id: TeamId, signal: AbortSignal): AsyncIterableIterator<number> {
    signal.throwIfAborted()
    let revision = 0
    let sent = -1
    let done = false
    let pending: PromiseWithResolvers<IteratorResult<number>> | undefined
    let observers = this.observers.get(id)
    if (observers === undefined) {
      observers = new Set()
      this.observers.set(id, observers)
    }
    const close = (): void => {
      done = true
      signal.removeEventListener('abort', close)
      observers.delete(changed)
      if (observers.size === 0) this.observers.delete(id)
      pending?.resolve({ value: undefined, done: true })
      pending = undefined
    }
    const changed = (): void => {
      if (this.closed) { close(); return }
      revision += 1
      if (pending !== undefined) {
        sent = revision
        pending.resolve({ value: revision, done: false })
        pending = undefined
      }
    }
    observers.add(changed)
    signal.addEventListener('abort', close, { once: true })
    if (this.closed) close()
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (done) return Promise.resolve({ value: undefined, done: true })
        if (sent !== revision) {
          sent = revision
          return Promise.resolve({ value: revision, done: false })
        }
        if (pending !== undefined) return Promise.reject(new Error('Team activity already has a pending read'))
        pending = Promise.withResolvers<IteratorResult<number>>()
        return pending.promise
      },
      return() {
        close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }

  /**
   * Wait for one later Team-domain or member-status change.
   * @param id - Team whose next edge wakes the caller.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for this wait only.
   * @returns whether the wait ended by timeout.
   */
  async wait(id: TeamId, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
      throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', 'TEAM_INVALID_TIMEOUT')
    }
    signal.throwIfAborted()
    if (this.closed) return { timedOut: false }
    const changed = await new Promise<boolean>((resolve, reject) => {
      let waiters = this.waiters.get(id)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(id, waiters)
      }
      let settled = false
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(id)
        settle()
      }
      const onAbort = (): void => {
        finish(() => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error
            ? reason
            : new TeamError(`wait_agent aborted: ${errorMessage(reason)}`, 'TEAM_WAIT_ABORTED'))
        })
      }
      const waiter: Waiter = {
        resolve: () => {
          finish(() => { resolve(true) })
        },
      }
      waiters.add(waiter)
      const timer = setTimeout(() => { finish(() => { resolve(false) }) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not replay an abort that wins between the pre-check and listener registration.
      if (signal.aborted) onAbort()
    })
    return { timedOut: !changed }
  }

  /**
   * Wake and remove every current waiter for one Team.
   * @param id - Team whose current waiters observe the change.
   */
  notify(id: TeamId): void {
    for (const observer of this.observers.get(id) ?? []) observer()
    const waiters = this.waiters.get(id)
    if (waiters === undefined) return
    this.waiters.delete(id)
    for (const waiter of waiters) waiter.resolve()
  }

  /** Close admission and wake every current waiter during runtime disposal. */
  close(): void {
    this.closed = true
    for (const observers of this.observers.values()) {
      for (const observer of observers) observer()
    }
    this.observers.clear()
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve()
    }
    this.waiters.clear()
  }
}
