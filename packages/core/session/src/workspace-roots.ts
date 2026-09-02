/**
 * The session's ADDITIONAL workspace roots: the durable multi-root fact that
 * sits beside the immutable primary root ({@link SessionHeader.cwd}). The
 * session log is the store — one `workspace/roots` event carries the COMPLETE
 * set, `effective = fold(events)`, so the set survives restart by replay, two
 * sessions can never see each other's roots, and there is no external store.
 * The event is log-only (the `sandbox/mode` precedent): consumers project the
 * fold into sandbox-policy resolution, search coverage, language-server
 * routing, and per-root instruction loading.
 *
 * Roots are recorded as supplied: absolute, non-empty, deduplicated by exact
 * spelling, and never the primary root's spelling. Canonicalization and
 * filesystem identity belong to the resolution step that hands a root set to
 * an enforcement layer, so this module performs no filesystem access.
 *
 * @module dsh-session/workspace-roots
 */

import { isAbsolute } from 'node:path'
import type { Session } from './index.ts'
import type { SessionEvent } from './types.ts'

/**
 * The session's additional workspace roots: the roots of the LAST
 * `workspace/roots` event, or an empty list when the session never recorded
 * any. The pure fold — resume needs no catch-up machinery because replaying
 * the log IS the state.
 * @param events - session events in log order (other event types are skipped).
 * @returns the recorded additional roots, empty when none were ever recorded.
 */
export function effectiveWorkspaceRoots(events: readonly SessionEvent[]): readonly string[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'workspace/roots') return event.data.roots
  }
  return []
}

/**
 * Every workspace root the session works in: its primary root
 * ({@link SessionHeader.cwd}) first, then the recorded additional roots,
 * deduplicated by spelling. This is the list a consumer walks when it acts on
 * the user's directories — search coverage, language-server routing, per-root
 * instruction loading — rather than on the write fence, whose canonical form
 * the sandbox policy owns.
 * @param session - the session whose roots to list.
 * @returns the roots, primary first; empty for a session with no cwd and no
 *   recorded roots.
 */
export function sessionWorkspaceRoots(session: Session): string[] {
  const cwd = session.header.cwd
  const roots = cwd === undefined ? [] : [cwd]
  for (const root of effectiveWorkspaceRoots(session.events)) {
    if (!roots.includes(root)) roots.push(root)
  }
  return roots
}

/**
 * THE write path for a session's additional workspace roots: appends one
 * `workspace/roots` event carrying the complete replacement set — the change
 * IS its event; nothing mutates root state out of band. Takes effect on the
 * session's next resolved capability call (sandbox policy, search, lsp,
 * instructions), because every consumer folds on read.
 *
 * Re-declaring the set the session already carries appends nothing: a client
 * that restates its workspace on every resume must not grow the log with
 * events the fold cannot distinguish.
 *
 * Misconfiguration fails loud here, at the earliest point that owns the
 * session: a relative or empty root is rejected rather than silently dropped
 * where an enforcement layer would later fail to match it.
 * @param session - the session the roots belong to.
 * @param roots - the complete set of additional absolute roots, replacing any
 *   earlier set. Duplicate spellings and the session's own primary root are
 *   removed; an empty result records that the session works in its primary
 *   root alone.
 * @throws Error when a root is empty or not an absolute path.
 */
export function setAdditionalWorkspaceRoots(session: Session, roots: readonly string[]): void {
  const recorded: string[] = []
  for (const root of roots) {
    if (root.length === 0) throw new Error('workspace root must not be empty')
    if (!isAbsolute(root)) throw new Error(`workspace root must be an absolute path, got "${root}"`)
    if (root === session.header.cwd || recorded.includes(root)) continue
    recorded.push(root)
  }
  const current = effectiveWorkspaceRoots(session.events)
  if (recorded.length === current.length && recorded.every((root, index) => root === current[index])) return
  session.append('workspace/roots', { roots: recorded })
}
