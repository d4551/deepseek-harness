/** Startup cleanup mechanics for local spill roots. */
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_ROOT_PREFIX, isErrno } from './store.ts'

/** Values a Promise reject arm from a best-effort sweep may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/**
 * Human text for a rejected filesystem operation.
 * @param reason - the Thrown the reject arm received.
 * @returns the message to report.
 */
function thrownMessage(reason: Thrown): string {
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

/**
 * A backend-generated default root name: `dsh-spill-` plus the 6-character
 * suffix `mkdtemp` appends. Discovery matches this
 * EXACT shape, not the bare prefix, so an unrelated `dsh-spill-test-*` fixture
 * or a foreign tool's differently-shaped `dsh-spill-…` directory is never
 * mistaken for a backend root to sweep.
 */
const DEFAULT_ROOT_RE = new RegExp(`^${DEFAULT_ROOT_PREFIX}[A-Za-z0-9]{6}$`)

/**
 * A backend-generated session directory name: `session-` plus the 12 lowercase
 * hex characters {@link sessionDir} derives from `sha256(sessionId)`. The sweep
 * only descends into entries of this EXACT shape, so an unrelated
 * `session-backup` directory under a shared configured root is never swept.
 */
const SESSION_DIR_RE = /^session-[0-9a-f]{12}$/

/** An existing root resolved to one stable filesystem identity. */
interface ResolvedRoot {
  /** Canonical absolute path used for the sweep. */
  path: string
  /** Device/inode identity used to de-duplicate filesystem aliases. */
  identity: string
}

/** A one-argument warning sink — the sweep's only side effect on failure (never throws). */
export type WarnFn = (message: string) => void

/** Report a best-effort sweep failure without allowing the warning sink to reject cleanup. */
function warnSafely(warn: WarnFn, message: string): void {
  try {
    warn(message)
  } catch {
    // Warning sinks are observational callbacks; cleanup must remain best-effort
    // even when a logger implementation throws.
  }
}

/**
 * One directory audit against the Windows DACL vocabulary, resolved once per
 * process. POSIX ownership and mode bits do not exist on Windows, so the same
 * questions — "can another account write here" and "can another account
 * replace this entry" — are put to the object's access-control list instead of
 * being answered `true` unasked.
 */
type WindowsDirectoryAudit = (path: string, accessMask: number) => string | undefined

let windowsDirectoryAudit: Promise<WindowsDirectoryAudit> | undefined

function loadWindowsDirectoryAudit(): Promise<WindowsDirectoryAudit> {
  windowsDirectoryAudit ??= import('@deepseek-ai/dsh-win32-process/file-security').then(
    ({ auditPathAccessWin32, describeWin32Exposure }) =>
      (path: string, accessMask: number) => describeWin32Exposure(auditPathAccessWin32(path, accessMask)),
  )
  return windowsDirectoryAudit
}

/** Whether another local OS user cannot replace children of this directory. */
async function isTrustedDirectory(path: string, stats: Stats): Promise<boolean> {
  if (!stats.isDirectory()) return false
  if (process.platform === 'win32') {
    const { DIRECTORY_WRITE_ACCESS } = await import('@deepseek-ai/dsh-win32-process/file-security')
    return (await loadWindowsDirectoryAudit())(path, DIRECTORY_WRITE_ACCESS) === undefined
  }
  if (process.geteuid === undefined) return false
  return stats.uid === process.geteuid() && (stats.mode & 0o022) === 0
}

/** Stable identity for de-duplicating aliases of one root. */
function rootIdentity(path: string, stats: Stats): string {
  if (process.platform === 'win32') return path.toLowerCase()
  return `${String(stats.dev)}:${String(stats.ino)}`
}

/**
 * Check that no ancestor permits another local OS user to replace the selected
 * child. A sticky writable ancestor is safe because the child is owned by the
 * current user; this admits normal per-process roots below `/tmp`.
 */
async function hasProtectedAncestors(path: string): Promise<boolean> {
  if (process.platform === 'win32') return hasProtectedAncestorsWin32(path)
  if (process.geteuid === undefined) return false
  const currentUid = process.geteuid()
  let child = path
  let childStats = await lstat(child)
  for (;;) {
    const parent = dirname(child)
    if (parent === child) return true
    const stats = await lstat(parent)
    if (!stats.isDirectory()) return false
    const writableByOthers = (stats.mode & 0o022) !== 0
    const sticky = (stats.mode & 0o1000) !== 0
    if (writableByOthers && !sticky) return false
    if (writableByOthers && childStats.uid !== currentUid) return false
    child = parent
    childStats = stats
  }
}

/**
 * The Windows half of {@link hasProtectedAncestors}: no ancestor may let
 * another account replace the entry below it. Creation rights are ignored
 * because the volume root grants them to everyone while still refusing to let
 * one account delete another's entry — the Windows equivalent of the sticky
 * `/tmp` the POSIX walk admits.
 * @param path - the canonical root whose ancestry is inspected.
 * @returns whether every ancestor withholds replace access from other accounts.
 */
async function hasProtectedAncestorsWin32(path: string): Promise<boolean> {
  const { DIRECTORY_REPLACE_ACCESS } = await import('@deepseek-ai/dsh-win32-process/file-security')
  const audit = await loadWindowsDirectoryAudit()
  let child = path
  for (;;) {
    const parent = dirname(child)
    if (parent === child) return true
    if (audit(parent, DIRECTORY_REPLACE_ACCESS) !== undefined) return false
    child = parent
  }
}

/**
 * Resolve one existing root without admitting a directory another local user
 * can replace during the path-based sweep. A configured root may be a symlink;
 * discovery passes `false` so a symlink cannot impersonate a default root.
 *
 * @param path Candidate root path.
 * @param allowSymlink Whether the candidate itself may be a configured symlink.
 * @param warn Sink for skipped or failed inspection.
 * @returns The trusted canonical root, or `undefined` when it is absent or unsafe.
 */
async function resolveRoot(path: string, allowSymlink: boolean, warn: WarnFn): Promise<ResolvedRoot | undefined> {
  const initial = await lstat(path).then(
    undefined,
    (error: Thrown) => {
      if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to inspect root ${path}: ${thrownMessage(error)}`)
      return undefined
    },
  )
  if (initial === undefined) return undefined
  if (initial.isSymbolicLink()) {
    if (!allowSymlink) return undefined
  } else if (!await isTrustedDirectory(path, initial)) {
    warnSafely(warn, `spill-local: skipped unsafe root ${path}: expected a directory owned by the current user and not writable by group or others`)
    return undefined
  }

  const resolved = await realpath(path).then(
    canonical => lstat(canonical).then(stats => ({ canonical, stats })),
  ).then(
    undefined,
    (error: Thrown) => {
      if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to resolve root ${path}: ${thrownMessage(error)}`)
      return undefined
    },
  )
  if (resolved === undefined) return undefined
  const { canonical, stats } = resolved
  const protectedAncestors = await hasProtectedAncestors(canonical).then(
    undefined,
    (error: Thrown) => {
      if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to inspect ancestors of root ${canonical}: ${thrownMessage(error)}`)
      return undefined
    },
  )
  if (protectedAncestors === undefined) return undefined
  if (!await isTrustedDirectory(canonical, stats) || !protectedAncestors) {
    warnSafely(warn, `spill-local: skipped unsafe root ${canonical}: expected a current-user-owned directory with protected write and ancestor permissions`)
    return undefined
  }
  return { path: canonical, identity: rootIdentity(canonical, stats) }
}

/** One root to sweep, plus whether the root itself may be pruned once empty. */
export interface SweepRoot {
  /** Absolute spill root to sweep. */
  path: string
  /**
   * When `true`, remove the root after its empty `session-*` children are
   * pruned. Set for DISCOVERED prior-default `dsh-spill-*` roots (one per past
   * process — otherwise they accumulate empty forever), never for the active
   * root the live process is still writing into. Every root prunes empty session
   * directories; writes retry if that races their removal.
   */
  pruneWhenEmpty: boolean
}

/** Options for {@link sweepSpillRoots} — the roots to scan, the age cutoff, and a failure sink. */
export interface SweepOptions {
  /** Roots to sweep (configured/active root and/or discovered prior-default roots). */
  roots: SweepRoot[]
  /**
   * Epoch-millis cutoff: a regular file is deleted when its `mtime` is strictly
   * older than this. The caller derives it from `now - cleanupPeriodDays`, so a
   * file written exactly at the boundary is kept (only strictly-older expires).
   */
  cutoffMs: number
  /** Where a contained filesystem failure is reported; the sweep itself never throws. */
  warn: WarnFn
}

/**
 * Delete a single path, treating a concurrent-race disappearance as success.
 * A parallel process (or another sweep) may `unlink` the same file between our
 * scan and our own `unlink` — ENOENT then means the goal (file gone) already
 * holds, so it is not a failure. Any other error is reported and swallowed.
 *
 * @param path The absolute file path to remove.
 * @param warn Sink for a non-ENOENT failure message.
 * @returns Resolves once the removal was attempted (never rejects).
 */
function unlinkIdempotent(path: string, warn: WarnFn): Promise<void> {
  return unlink(path).then(
    undefined,
    (error: Thrown) => {
      if (isErrno(error, 'ENOENT')) return
      warnSafely(warn, `spill-local: failed to delete ${path}: ${thrownMessage(error)}`)
    },
  )
}

/**
 * Sweep one spill session directory: delete expired regular files, skip
 * everything else, and report whether the scan completed. The caller prunes
 * with nonrecursive `rmdir`, which checks actual emptiness. The caller verifies
 * that `dir` is a real directory, so this never follows a `session-*` symlink into a
 * foreign tree. Inside, a symlink or any non-regular entry (socket, fifo, nested
 * dir) is left untouched — `lstat` never follows a link, so a planted symlink
 * can neither be deleted nor redirect the age check. Every per-entry failure is
 * contained: one unreadable file does not abort the directory.
 *
 * @param dir The absolute session directory to scan (already confirmed a real dir).
 * @param cutoffMs Files with `mtime` strictly older than this are deleted.
 * @param warn Sink for contained filesystem failures.
 * @returns `true` when the directory scan completed and pruning can be attempted.
 */
function sweepSessionDir(dir: string, cutoffMs: number, warn: WarnFn): Promise<boolean> {
  return readdir(dir).then(
    async (names) => {
      for (const name of names) {
        const path = join(dir, name)
        const stats = await lstat(path).then(
          undefined,
          (error: Thrown) => {
            if (isErrno(error, 'ENOENT')) return undefined
            warnSafely(warn, `spill-local: failed to stat ${path}: ${thrownMessage(error)}`)
            return undefined
          },
        )
        if (stats === undefined) continue
        // Only regular files expire. Symlinks and other special entries are skipped
        // (never followed) so the sweep cannot be redirected or delete a link.
        if (!stats.isFile()) continue
        if (stats.mtimeMs >= cutoffMs) continue
        await unlinkIdempotent(path, warn)
      }
      return true
    },
    (error: Thrown) => {
      warnSafely(warn, `spill-local: failed to read ${dir}: ${thrownMessage(error)}`)
      return false
    },
  )
}

/**
 * Best-effort one-shot cleanup: across each root, delete expired regular files
 * under its `session-*` directories and prune every empty session directory.
 * Only a discovered prior-default root is itself removed. Writes recreate a
 * session directory when pruning races a local write. Every filesystem and
 * warning-sink failure is contained, so a caller can await this during
 * activation/disposal without it ever rejecting.
 *
 * @param options The roots to sweep, the age cutoff, and the failure sink.
 * @returns Resolves when the sweep finishes (never rejects).
 */
export async function sweepSpillRoots(options: SweepOptions): Promise<void> {
  const { cutoffMs, warn } = options
  const roots = new Map<string, SweepRoot>()
  for (const candidate of options.roots) {
    const resolved = await resolveRoot(candidate.path, false, warn)
    if (resolved === undefined) continue
    const existing = roots.get(resolved.identity)
    roots.set(resolved.identity, {
      path: resolved.path,
      pruneWhenEmpty: (existing?.pruneWhenEmpty ?? true) && candidate.pruneWhenEmpty,
    })
  }
  for (const root of roots.values()) {
    const entries = await readdir(root.path).then(
      undefined,
      (error: Thrown) => {
        // A root that does not exist yet (no spill ever written) is the common
        // case, not an error: ENOENT is silent, anything else is reported.
        if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to read root ${root.path}: ${thrownMessage(error)}`)
        return undefined
      },
    )
    if (entries === undefined) continue
    for (const name of entries) {
      // Only the backend's own `session-<12 hex>` directories are swept; an
      // unrelated sibling (`session-backup`, a stray file) is left untouched and
      // blocks pruning the root.
      if (!SESSION_DIR_RE.test(name)) continue
      const dir = join(root.path, name)
      // lstat the session entry itself: a `session-*` SYMLINK must never be
      // followed (readdir/unlink through it would delete files in a foreign
      // target). Only a real directory is swept.
      const stats = await lstat(dir).then(
        undefined,
        (error: Thrown) => {
          if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to stat ${dir}: ${thrownMessage(error)}`)
          return undefined
        },
      )
      if (stats === undefined) continue
      if (!await isTrustedDirectory(dir, stats)) {
        warnSafely(warn, `spill-local: skipped unsafe session directory ${dir}`)
        continue
      }
      const scanned = await sweepSessionDir(dir, cutoffMs, warn)
      if (!scanned) continue
      await rmdir(dir).then(
        undefined,
        (error: Thrown) => {
          if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
            warnSafely(warn, `spill-local: failed to prune ${dir}: ${thrownMessage(error)}`)
          }
        },
      )
    }
    // A discovered prior-default root (one per past process) is removed once its
    // last session dir is gone — otherwise empty roots accumulate forever and
    // every future startup rescans them. The active root itself is never pruned.
    if (root.pruneWhenEmpty) {
      await rmdir(root.path).then(
        undefined,
        (error: Thrown) => {
          if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
            warnSafely(warn, `spill-local: failed to prune root ${root.path}: ${thrownMessage(error)}`)
          }
        },
      )
    }
  }
}

/**
 * Discover prior default spill roots: the `dsh-spill-<6 chars>` directories
 * directly under `base` (the OS tmpdir) that earlier default-root runs created.
 * A long-lived deployment
 * with a configured root will find none; a series of default-root runs
 * accumulates one per process, so the startup sweep reclaims them all. Matching
 * is the EXACT `mkdtemp` shape (see {@link DEFAULT_ROOT_RE}), not the bare
 * prefix, so an unrelated `dsh-spill-test-*` fixture or a foreign
 * differently-shaped directory is never swept; symlinks and non-directories are
 * excluded too — only real directories the backend could have created.
 *
 * @param warn Sink for a failure reading `base` (returns `[]` on failure).
 * @param base The directory to scan; defaults to the OS tmpdir (a test seam).
 * @returns Absolute paths of the discovered default roots (possibly empty).
 */
function discoverDefaultRootRecords(warn: WarnFn, base: string): Promise<ResolvedRoot[]> {
  return readdir(base).then(
    async (entries) => {
      const roots: ResolvedRoot[] = []
      for (const name of entries) {
        if (!DEFAULT_ROOT_RE.test(name)) continue
        const path = join(base, name)
        const resolved = await resolveRoot(path, false, warn)
        if (resolved !== undefined) roots.push(resolved)
      }
      return roots
    },
    (error: Thrown) => {
      warnSafely(warn, `spill-local: failed to scan ${base} for default roots: ${thrownMessage(error)}`)
      return []
    },
  )
}

/**
 * Discover trusted prior default roots below the OS temporary directory.
 *
 * @param warn Sink for contained discovery failures.
 * @param base Directory to scan; defaults to the OS temporary directory.
 * @returns Canonical paths of trusted default roots.
 */
export async function discoverDefaultRoots(warn: WarnFn, base: string = tmpdir()): Promise<string[]> {
  return (await discoverDefaultRootRecords(warn, base)).map(root => root.path)
}

/**
 * Gather and de-duplicate the trusted roots for one startup sweep. The active
 * configured path may be a symlink; its resolved identity overrides a matching
 * discovered root so the live target is never marked prunable.
 *
 * @param activeRoot Active configured root.
 * @param warn Sink for contained inspection failures.
 * @param defaultRootsBase Directory holding prior default roots.
 * @returns Trusted roots with the active identity marked non-prunable.
 */
export async function gatherSweepRoots(
  activeRoot: string,
  warn: WarnFn,
  defaultRootsBase: string = tmpdir(),
): Promise<SweepRoot[]> {
  const [discovered, active] = await Promise.all([
    discoverDefaultRootRecords(warn, defaultRootsBase),
    resolveRoot(activeRoot, true, warn),
  ])
  const roots = new Map<string, SweepRoot>()
  for (const root of discovered) roots.set(root.identity, { path: root.path, pruneWhenEmpty: true })
  if (active !== undefined) roots.set(active.identity, { path: active.path, pruneWhenEmpty: false })
  return [...roots.values()]
}
