/**
 * The per-workspace-SCOPE write identity: a deterministic `S-1-4-x-y` SID
 * derived from the canonical set of workspace roots one confined execution
 * may write, whose ACEs form that scope's write allowlist. Every confined
 * execution of the same root set — across sessions, server restarts, and
 * calls — carries the SAME write SID, so each root's ACE materializes once
 * per scope per machine (the grant's exact-ACE skip then makes every later
 * provision O(1)) instead of once per session. Deriving from the whole set
 * rather than one root is what keeps multi-root confinement honest: a
 * session sharing only the primary root holds a different SID, so it cannot
 * write another session's additional roots through their standing ACEs.
 * The SID's power is defined solely by the ACEs that name it (which exist
 * only on that scope's workspace trees and the session's private temp
 * directory), and only tokens minted for that scope carry it — the SID
 * string itself is not a secret. Temporary directories use a separate,
 * per-directory identity from {@link tempWriteSid}; sharing the workspace
 * identity with temp would let sibling sessions write one another's temp
 * trees.
 *
 * Every input MUST be a canonical workspace path (`realpathSync.native` on
 * Windows — the sandbox-policy `resolveWorkspaceRoot` already applies it):
 * canonicalization converges case/alias spellings, so two spellings of one
 * workspace derive one SID; an as-spelled fallback path would mint a second
 * identity for the same directory (self-healing, at the cost of one extra
 * tree propagation). Renaming the workspace directory derives a new SID —
 * the old standing ACEs are inert residue, and the next session re-propagates
 * once.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/workspace-sid
 */

import { createHash } from 'node:crypto'

/**
 * Derive the workspace scope's write SID (`S-1-4-x-y`; subauthorities 30-bit,
 * matching the workspace-capability shape the token and ACE layers carry).
 * The roots are sorted and NUL-joined before hashing, so the identity depends
 * on the set and not on the order the caller lists it in.
 * @param workspaceRoots - the canonical workspace paths this scope may write.
 * @returns the SDDL string form.
 */
export function workspaceWriteSid(workspaceRoots: readonly string[]): string {
  const digest = createHash('sha256').update([...workspaceRoots].sort().join('\0'), 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}`
}

/**
 * Derive one private temp directory's write SID. The random directory path
 * is the capability identity; a fixed third subauthority domain-separates
 * the result from every two-subauthority workspace SID.
 * @param tempDir - the private temp directory's absolute path.
 * @returns the SDDL string form.
 */
export function tempWriteSid(tempDir: string): string {
  const digest = createHash('sha256').update('temp\0', 'utf8').update(tempDir, 'utf8').digest()
  const first = (digest.readUInt32LE(0) % (2 ** 30 - 1)) + 1
  const second = (digest.readUInt32LE(4) % (2 ** 30 - 1)) + 1
  return `S-1-4-${first}-${second}-1`
}
