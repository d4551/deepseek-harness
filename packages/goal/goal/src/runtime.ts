/** Runtime constructors and protocol constants for the goal domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { GoalId as GoalIdType } from './types.ts'
import { GOAL_ERROR_CODES, type GoalErrorCode } from './domain.ts'

/** Version of the goal change embedded in a round-zero message source. */
export const GOAL_CHANGE_VERSION = 1

/**
 * Brand a string as a goal id.
 * @param id - raw goal identifier.
 * @returns the same string with the compile-time brand.
 */
export function GoalId(id: string): GoalIdType {
  if (id === '') throw new TypeError('goal id must be a non-empty string')
  return id as GoalIdType
}

/** True when `code` is a member of {@link GOAL_ERROR_CODES}. */
function isGoalErrorCode(code: string): code is GoalErrorCode {
  return Object.hasOwn(GOAL_ERROR_CODES, code)
}

/** Error returned by the goal domain boundary. */
export class GoalError extends HarnessError {
  declare readonly code: GoalErrorCode

  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification; rejected at runtime when outside the taxonomy.
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    if (!isGoalErrorCode(code)) {
      throw new TypeError(`unrecognized goal error code: ${code}`)
    }
    super(message, code, options)
  }
}
