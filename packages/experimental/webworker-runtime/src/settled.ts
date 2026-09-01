/**
 * Promise boundary for the synchronous VFS beneath this runtime's asynchronous
 * Node faces. `node:fs/promises` and the module seam report failure by
 * rejecting, while the calls under them throw, so every asynchronous face runs
 * its synchronous work through this module.
 *
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/settled
 */

/**
 * Run one synchronous call inside a promise boundary.
 * @param operation - synchronous call to run.
 * @returns its result, or a rejection carrying whatever it threw.
 */
export function settled<T>(operation: () => T): Promise<T> {
  return new Promise((resolve) => { resolve(operation()) })
}
