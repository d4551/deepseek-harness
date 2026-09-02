/**
 * Derive the workspace root an `lsp` call resolves against from the calling
 * agent's session. A missing cwd fails as `LSP_WORKSPACE_REQUIRED` because the
 * local provider must canonicalize a real workspace before starting a server.
 * @module @deepseek-ai/dsh-tool-lsp/session-cwd
 */

import { isAbsolute, relative, sep } from 'node:path'
import { sessionWorkspaceRoots } from '@deepseek-ai/dsh-session/workspace-roots'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Whether `root` is `target` or a directory containing it, lexically. */
function contains(root: string, target: string): boolean {
  const relation = relative(root, target)
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))
}

/**
 * The session workspace root ONE query runs against, or `undefined` when none
 * applies. The seam takes exactly one root per query, so a multi-root session
 * routes each queried file to the root that contains it: the language server
 * then indexes that file's own project instead of a sibling root that never
 * references it. The deepest containing root wins, so a root nested inside
 * another still owns its own files.
 *
 * A relative path resolves against the primary root — the base the model's
 * relative paths are written against — and an absolute path under no root
 * falls back to the primary root, leaving the provider to report the
 * unresolvable file rather than inventing a workspace here.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @param filePath - the file the query names, as the model supplied it.
 * @returns the workspace root for this query, or undefined for a non-agent caller.
 */
export function sessionWorkspaceRoot(exec: ToolExecution, filePath: string): string | undefined {
  const session = exec.agent?.session
  if (session === undefined) return undefined
  const roots = sessionWorkspaceRoots(session)
  const primary = roots[0]
  if (primary === undefined || !isAbsolute(filePath)) return primary
  let deepest: string | undefined
  for (const root of roots) {
    if (contains(root, filePath) && (deepest === undefined || root.length > deepest.length)) deepest = root
  }
  return deepest ?? primary
}
