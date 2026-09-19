/** Schedule-owned use of the shared session durability barrier. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/** Failure to prove that the current live prefix reached a persistence listener. */
export class SchedulePersistenceError extends Error {
  /**
   * Construct a contained persistence failure.
   * @param cause - Rejection returned by the shared barrier, when present.
   */
  constructor(cause?: unknown) {
    super('Schedule persistence did not complete.', cause === undefined ? undefined : { cause })
    this.name = 'SchedulePersistenceError'
  }
}

/**
 * Require one successful shared persistence checkpoint.
 * @param ctx - Context carrying the live session store.
 * @param session - Exact live session to checkpoint.
 * @returns After at least one listener explicitly acknowledges completed durability work.
 */
export function flushSchedulePersistence(ctx: Context, session: Session): Promise<void> {
  return ctx.sessions.flush(session).then(
    (acknowledged) => {
      if (!acknowledged) throw new SchedulePersistenceError()
    },
    (error: Thrown) => {
      throw new SchedulePersistenceError(error)
    },
  )
}
