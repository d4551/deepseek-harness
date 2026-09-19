/** Typed Agent Teams failures. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable failure raised by the Team domain. */
export class TeamError extends HarnessError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'TeamError'
  }
}

/**
 * Human text for a thrown Team value.
 * @param error - the claim-boundary value to render.
 * @returns the Error message, primitive text, a null or undefined literal, or an object tag.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  switch (typeof error) {
    case 'string': return error
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(error)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (error === null) return 'null'
      return Object.prototype.toString.call(error)
  }
}
