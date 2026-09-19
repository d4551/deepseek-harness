import type { Thrown } from '@deepseek-ai/dsh-thrown'

/**
 * Surface a rejected workspace mutation as text.
 * @param reason - the promise rejection.
 * @returns the Error message, or the stringified refusal.
 */
export function mutationFailureMessage(reason: Thrown): string {
  if (reason instanceof Error) return reason.message
  switch (typeof reason) {
    case 'string': return reason
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(reason)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (reason === null) return 'null'
      return Object.prototype.toString.call(reason)
  }
}
