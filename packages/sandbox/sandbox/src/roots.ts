/**
 * The writable-root derivation shared by every enforcement dialect that
 * expresses a mode as a canonical allow-list: `workspace-write` means "every
 * workspace root the session works in plus the platform temp areas", and this
 * module is that meaning's one home. The Seatbelt profile
 * (`@deepseek-ai/dsh-sandbox-local`) and the in-process filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) both derive their allow-list here, so "the
 * write tool cannot write /tmp but bash can" asymmetries cannot arise between
 * them. The bwrap and Landlock dialects keep their own grant spellings (an
 * ephemeral `/tmp` mount, launcher-owned flags) — the honest per-runner
 * differences recorded in the sandbox RFC — with parity pinned by test.
 *
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SandboxExecutionPolicy } from './index.ts'

/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export function canonicalPath(path: string): string {
  try {
    // Node's JavaScript realpath implementation lexically collapses `..`
    // before resolving a preceding symlink on some platforms. The native
    // implementation follows the filesystem's component-by-component lookup,
    // matching chdir/spawn and the enforcement layers this identity feeds.
    return realpathSync.native(path)
  } catch {
    // realpathSync.native failed: the path (or a prefix) is missing or unreadable.
    return path
  }
}

/**
 * The system-wide temp directory POSIX platforms always have. It is NOT a
 * portable spelling: on Windows `/tmp` is drive-relative and resolves to
 * `C:\tmp`, a path no runtime uses for temporary files, so granting it there
 * would widen every dialect's allow-list to a meaningless location.
 */
const POSIX_SYSTEM_TEMP_DIR = '/tmp'

/**
 * The temp areas `workspace-write` grants beside the workspace roots: the
 * per-user platform temp dir (`os.tmpdir()` — the real temp area for
 * mkstemp-family tools; omitting it would deny what the mode promises) plus,
 * on POSIX only, the system-wide {@link POSIX_SYSTEM_TEMP_DIR}.
 * @returns the temp roots this platform actually has.
 */
function platformTempRoots(): string[] {
  return process.platform === 'win32' ? [tmpdir()] : [POSIX_SYSTEM_TEMP_DIR, tmpdir()]
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's primary workspace root, every
 * additional workspace root the session recorded, and the platform temp
 * areas. Order is primary root, additional roots as resolved, then temp; a
 * given root set therefore always yields the same list, which is what keeps
 * the model-facing policy sentence byte-stable.
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  const roots = [policy.workspaceRoot, ...policy.additionalWorkspaceRoots ?? [], ...platformTempRoots()]
  return [...new Set(roots.map(canonicalPath))]
}

/**
 * The WORKSPACE roots one policy names — the primary root followed by the
 * session's additional roots, deduplicated, with no temp area. This is the set
 * an enforcement dialect grants when it expresses roots as PATHS rather than
 * as a resolved allow-list (bwrap binds, Landlock grants, the windows-acl
 * runner's `--workspace` flags and the write SID derived from them).
 *
 * The roots are returned exactly as the policy specifies them: resolution is
 * the policy owner's step ({@link SandboxExecutionPolicy}), and a dialect that
 * re-resolved them would grant a path its caller never named.
 * {@link writableRoots} canonicalizes instead, because the fence it feeds
 * compares resolved paths.
 * @param policy - the file-effect policy to derive the root set from.
 * @returns the policy's workspace roots, primary first; never empty.
 */
export function workspaceRoots(policy: SandboxExecutionPolicy): string[] {
  return [...new Set([policy.workspaceRoot, ...policy.additionalWorkspaceRoots ?? []])]
}
