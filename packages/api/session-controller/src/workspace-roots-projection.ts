/**
 * The `workspaceRoots` projection unit: the Session's immutable primary root
 * plus the fold of its `workspace/roots` log.
 *
 * The fold mirrors `effectiveWorkspaceRoots` — the last `workspace/roots`
 * event carries the COMPLETE set, so each one replaces the state rather than
 * accumulating into it — and pairs the result with the header `cwd` the unit
 * is initialized from. That pair is what every root consumer already resolves
 * (sandbox write fence, search coverage, language-server routing, per-root
 * instruction loading), so a client reading this key sees the same root set
 * the model works in, live and after reconnect, with no client-side folding.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { WorkspaceRootsProjection } from './types.ts'

const workspaceRootsSchema: z.ZodType<WorkspaceRootsProjection> = z.object({
  primary: z.string().nullable(),
  additional: z.array(z.string()).readonly(),
}).readonly()

/**
 * Whether two recorded root lists are the same set in the same order. The
 * projection contract requires an unchanged state REFERENCE for an event the
 * unit does not act on, and a `workspace/roots` event restating the set the
 * Session already carries is exactly that.
 * @param left - roots already folded.
 * @param right - roots the next event carries.
 * @returns true when neither the order nor the spellings differ.
 */
function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((root, index) => root === right[index])
}

/**
 * Advance the recorded root set by one Session event.
 * @param state - roots before the event.
 * @param event - next committed Session event.
 * @returns the original state, or one carrying the event's complete replacement set.
 */
function applyWorkspaceRoots(
  state: WorkspaceRootsProjection,
  event: SessionEvent,
): WorkspaceRootsProjection {
  if (event.type !== 'workspace/roots') return state
  return sameRoots(state.additional, event.data.roots)
    ? state
    : { primary: state.primary, additional: [...event.data.roots] }
}

const workspaceRootsProjection = {
  key: 'workspaceRoots',
  stateSchema: workspaceRootsSchema,
  init: header => ({ primary: header.cwd ?? null, additional: [] }),
  apply: applyWorkspaceRoots,
  wire: { viewSchema: workspaceRootsSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'workspaceRoots', WorkspaceRootsProjection>

/**
 * Register the workspace-root projection.
 * @param ctx - Session Controller context carrying the projection registry.
 */
export function installWorkspaceRootsProjection(ctx: Context): void {
  ctx.sessionProjections.register(workspaceRootsProjection)
}
