/**
 * Completion policy for an LSP operation and the cleanup it owns.
 * @module @deepseek-ai/dsh-lsp-stdio/outcome
 */

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
  const failures: unknown[] = []
  for (const outcome of [operation, ...cleanup]) {
    if (outcome.status === 'rejected' && !failures.includes(outcome.reason)) failures.push(outcome.reason)
  }
  if (failures.length > 1) {
    const details = failures.map(error => error instanceof Error ? error.message : String(error)).join('; ')
    throw new AggregateError(failures, `LSP operation and cleanup failed: ${details}`)
  }
  if (cleanup.some(outcome => outcome.status === 'rejected')) throw failures[0]
  if (operation.status === 'rejected') throw operation.reason
  return operation.value
}
