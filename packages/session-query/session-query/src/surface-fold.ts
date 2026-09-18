/** Session-query surface fold that maps contract failures onto the query taxonomy. */

import { foldSurface } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SurfaceFoldResult } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from './config.ts'

/**
 * Replay a log through the canonical surface fold.
 * @param events - complete contiguous raw event log.
 * @returns detached current sequences and replacement history.
 * @throws {@link SessionQueryError} with `SESSION_QUERY_INVALID_SURFACE` when the log breaks the surface contract.
 */
export function foldSessionQuerySurface(events: readonly SessionEvent[]): SurfaceFoldResult {
  return foldSurface(events, (message) => {
    throw new SessionQueryError(
      `invalid session surface: ${message}`,
      'SESSION_QUERY_INVALID_SURFACE',
    )
  })
}
