/** Bounded, escalating process shutdown for the long-lived CLI surfaces. */

/** Maximum grace allowed for the application tree to dispose before process exit. */
export const PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000

/** Process-exit controller shared by normal completion and Unix signal handlers. */
export interface ProcessShutdown {
  /** Start or join disposal before natural completion; failed or expired teardown forces a nonzero exit. */
  shutdown(code: number): Promise<void>
  /** Start graceful disposal followed by exit, or force exit when shutdown is already running. */
  interrupt(code: number): void
}

/**
 * Create one process-exit controller around an application disposer.
 * @param dispose - Whole-application teardown that resolves at quiescence.
 * @returns A controller whose normal calls coalesce and whose repeated signal call escalates.
 * Failed or expired disposal reports a diagnostic and changes a requested zero exit code to one.
 */
export function createProcessShutdown(dispose: () => Promise<void>): ProcessShutdown {
  let pending: Promise<void> | undefined

  const start = (code: number, forceAfterDispose: boolean): Promise<void> => {
    if (pending !== undefined) return pending
    const failureCode = code === 0 ? 1 : code
    const timeout = setTimeout(() => {
      console.error(`dsh: application disposal exceeded ${PROCESS_SHUTDOWN_TIMEOUT_MS}ms`)
      process.exit(failureCode)
    }, PROCESS_SHUTDOWN_TIMEOUT_MS)
    pending = Promise.allSettled([Promise.resolve().then(dispose)]).then(([disposal]) => {
      clearTimeout(timeout)
      if (disposal.status === 'rejected') {
        console.error('dsh: application disposal failed', disposal.reason)
        process.exit(failureCode)
      }
      if (forceAfterDispose) process.exit(code)
      process.exitCode = code
    })
    return pending
  }

  return {
    shutdown(code) {
      return start(code, false)
    },
    interrupt(code) {
      if (pending !== undefined) {
        process.exit(code)
      }
      pending = start(code, true)
    },
  }
}
