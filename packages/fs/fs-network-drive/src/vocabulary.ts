/**
 * Provider vocabulary: the target-key, version-token, and error translation
 * layer shared by the drive-backed filesystem provider and its modules.
 *
 * @module @deepseek-ai/dsh-fs-network-drive/vocabulary
 */

import { assertNever } from '@deepseek-ai/dsh-llm'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsInfo } from '@deepseek-ai/dsh-fs'
import { DriveError } from '@deepseek-ai/dsh-network-drive/identity'
import type { DriveStat, DriveVersion } from '@deepseek-ai/dsh-network-drive/types'
import type { LocalPathInfo } from './materialization.ts'

/** Prefix marking an {@link FsVersion} that names a drive revision. */
const DRIVE_VERSION_PREFIX = 'drive:'
/** Prefix marking an {@link FsVersion} of a working file the drive does not hold yet. */
const LOCAL_VERSION_PREFIX = 'local:'
/** Prefix marking an opaque target key as a drive path. */
const TARGET_KEY_PREFIX = 'drive:'

/**
 * The opaque target key this provider mints for one workspace-relative path.
 * Exposed for the invariant companion, which recomputes a recorded
 * observation's key to prove this provider minted it.
 * @param workspacePath - slash-separated path below the materialization root.
 * @returns the target key string.
 */
export function targetKeyFor(workspacePath: string): string {
  return `${TARGET_KEY_PREFIX}${workspacePath}`
}

/**
 * Whether one version token could have been issued by this provider: either a
 * drive revision or a local working digest.
 * @param version - the version recorded with an observation.
 * @returns true when the token carries one of this provider's authorities.
 */
export function isProviderVersion(version: FsVersion): boolean {
  const value = String(version)
  return value.startsWith(DRIVE_VERSION_PREFIX) || value.startsWith(LOCAL_VERSION_PREFIX)
}

/**
 * The workspace-relative drive path a target key names; the provider owns its
 * own key encoding.
 * @param targetKey - the opaque key this provider minted.
 * @returns the workspace-relative drive path.
 */
export function workspacePathOfKey(targetKey: string): string {
  return targetKey.slice(TARGET_KEY_PREFIX.length)
}

/** Where one target currently lives: on the drive, only in the local workspace, or nowhere. */
export type Placement =
  | { readonly kind: 'drive'; readonly remote: DriveStat }
  | { readonly kind: 'local'; readonly info: LocalPathInfo; readonly version: FsVersion }
  | { readonly kind: 'absent' }

/**
 * Raise the seam's abort error when the caller's signal has already fired.
 * @param signal - the caller's signal; `undefined` never aborts.
 * @param operation - the seam operation name the message opens with, as
 * `"<operation> aborted"`; callers pass the word the model already saw (`read`,
 * `write`, `edit`, `list`, `stat`, `resolve`).
 * @throws FsError `FS_ABORTED` when the signal is already aborted. This is a
 * checkpoint, not a cancellation: work already issued keeps running.
 */
export function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

/**
 * Translate one drive or workspace failure into the filesystem seam's
 * vocabulary. The drive code union is closed, so a new drive code fails
 * compilation here until it is given a filesystem meaning.
 * @param error - the failure a drive or `node:fs` operation raised.
 * @param operation - the filesystem operation name, for the message.
 * @param displayPath - the model-facing path the operation addressed.
 * @param signal - the caller's signal, which outranks the drive's classification.
 * @returns the typed filesystem error to raise. A `node:fs` `ENOENT` reports the
 * same `FS_NOT_FOUND` a missing drive path does, because a caller distinguishes
 * a workspace copy that is gone from a workspace it cannot read at all, and the
 * other seam providers name that failure the same way.
 */
export function mapError(error: FsError | DriveError | Error, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true) return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  if (!(error instanceof DriveError)) {
    if ('code' in error && error.code === 'ENOENT') {
      return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
    }
    return new FsError(`cannot ${operation} "${displayPath}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
  }
  const message = `cannot ${operation} "${displayPath}"`
  switch (error.code) {
    case 'DRIVE_NOT_FOUND':
      return new FsError(`${message}: not found`, 'FS_NOT_FOUND', { cause: error })
    case 'DRIVE_NOT_DIRECTORY':
      return new FsError(`${message}: not a directory`, 'FS_NOT_DIRECTORY', { cause: error })
    case 'DRIVE_NOT_FILE':
      return new FsError(`${message}: not a regular file`, 'FS_NOT_REGULAR_FILE', { cause: error })
    case 'DRIVE_PERMISSION_DENIED':
      return new FsError(`${message}: the drive denied access`, 'FS_PERMISSION_DENIED', { cause: error })
    case 'DRIVE_UNAUTHENTICATED':
      return new FsError(`${message}: the drive credential is missing or was rejected`, 'FS_PERMISSION_DENIED', { cause: error })
    case 'DRIVE_PRECONDITION_FAILED':
      return new FsError(`${message}: file changed since it was read`, 'FS_STALE_VERSION', { cause: error })
    case 'DRIVE_TOO_LARGE':
      return new FsError(`${message}: the drive refused the transfer size`, 'FS_TOO_LARGE', { cause: error })
    case 'DRIVE_ABORTED':
      return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
    case 'DRIVE_IO_ERROR':
      return new FsError(`${message}: ${error.message}`, 'FS_IO_ERROR', { cause: error })
    default:
      return assertNever(error, 'drive error')
  }
}

/**
 * The seam version token naming one drive revision. The `drive:` prefix keeps
 * the drive's authority separate from a {@link localToken}'s, so tokens minted
 * from the two sources never compare equal even when the underlying strings do.
 * @param version - the revision the drive reported for the entry, taken from a
 * `stat`, `list`, `read`, or `write` result and never constructed by this provider.
 * @returns the branded {@link FsVersion} recorded with an observation and
 * compared for equality by a guarded write; nothing downstream parses it.
 */
export function driveToken(version: DriveVersion): FsVersion {
  return FsVersion(`${DRIVE_VERSION_PREFIX}${version}`)
}

/** One settled promise: its value, or the rejection reason as an `Error`. */
export type Landed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Error }

/**
 * Settle one promise as data. The rejection reason is narrowed at runtime:
 * an `Error` (including `FsError` and `DriveError`) passes through with its
 * type intact, and any non-error rejection is wrapped, so downstream
 * translation always sees a real error value.
 * @param promise - the drive or filesystem call to settle; its rejection is
 * consumed here and never surfaces as an unhandled rejection.
 * @returns a promise that always fulfills, carrying the value on success and the
 * reason on failure. A non-`Error` rejection becomes `new Error(String(reason))`,
 * so `mapError` always receives a value it can classify; a caller reads the
 * outcome instead of catching it.
 */
export function landing<T>(promise: Promise<T>): Promise<Landed<T>> {
  return Promise.allSettled([promise]).then(([settled]): Landed<T> => {
    if (settled.status === 'fulfilled') return { ok: true, value: settled.value }
    return {
      ok: false,
      reason: settled.reason instanceof Error ? settled.reason : new Error(String(settled.reason)),
    }
  })
}

/**
 * The seam version token naming local working content the drive does not hold.
 * The `local:` prefix separates it from a {@link driveToken}: a guard holding one
 * authority can never match a placement that yields the other, so a working file
 * published since it was read rejects a stale guard instead of overwriting.
 * @param digest - a value that changes whenever the entry's content does: the
 * sha256 hex of a file's whole content whatever its size, or the entry kind for
 * anything that is not a file.
 * @returns the branded {@link FsVersion} for the working entry.
 */
export function localToken(digest: string): FsVersion {
  return FsVersion(`${LOCAL_VERSION_PREFIX}${digest}`)
}

/**
 * Filesystem-level entry kind for one drive entry kind. The drive union is
 * closed, so a new drive kind fails compilation here until it is given a
 * filesystem meaning.
 * @param type - the kind the drive reported for an entry it holds.
 * @returns the seam kind, one arm per drive kind. The drive reports no links, so
 * only {@link fsTypeOfLocal} has to decide what a link becomes.
 */
export function fsType(type: DriveStat['type']): FsInfo['type'] {
  switch (type) {
    case 'file':
      return 'file'
    case 'directory':
      return 'directory'
    case 'other':
      return 'other'
    default:
      return assertNever(type, 'drive entry type')
  }
}

/**
 * Filesystem-level entry kind for one local entry kind; a link is not a target kind.
 * @param type - the kind `lstat` reported for a materialized entry, which unlike
 * a drive kind can be `symlink`.
 * @returns `file` and `directory` unchanged, and `other` for a symlink or
 * anything else, because {@link FsInfo} has no link arm. Path-level `lstat`
 * output keeps the local kind instead of passing through here, which is how a
 * link stays visible to a consumer that must reject one.
 */
export function fsTypeOfLocal(type: LocalPathInfo['type']): FsInfo['type'] {
  return type === 'file' || type === 'directory' ? type : 'other'
}
