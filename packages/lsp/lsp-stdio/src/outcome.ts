/**
 * Completion policy for an LSP operation and the cleanup it owns.
 * @module @deepseek-ai/dsh-lsp-stdio/outcome
 */

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/**
 * Return the operation result only after all supplied cleanup outcomes succeed.
 * @param operation - the completed operation.
 * @param cleanup - completed cleanup operations, in execution order.
 * @returns the operation value, or throws every distinct retained failure.
 */
export function finishLspOperation<T>(
  operation: PromiseSettledResult<T>,
  ...cleanup: readonly PromiseSettledResult<unknown>[]
): T {
  const failures: Thrown[] = []
  for (const outcome of [operation, ...cleanup]) {
    if (outcome.status !== 'rejected') continue
    const reason: Thrown = outcome.reason
    if (!failures.includes(reason)) failures.push(reason)
  }
  if (failures.length > 1) {
    const details = failures.map(error => error instanceof Error ? error.message : String(error)).join('; ')
    throw new AggregateError(failures, `LSP operation and cleanup failed: ${details}`)
  }
  if (cleanup.some(outcome => outcome.status === 'rejected')) throw failures[0]
  if (operation.status === 'rejected') throw operation.reason
  return operation.value
}
