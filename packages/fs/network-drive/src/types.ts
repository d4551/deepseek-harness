/**
 * Vocabulary for the network-drive Service Definition (`ctx.networkDrive`): the opaque
 * remote-path and revision identities, the metadata `stat`/`list` return, the byte range a
 * read may request, the write precondition, and the closed failure-code union.
 * @module @deepseek-ai/dsh-network-drive/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque identity of one entry on the drive. A provider chooses the encoding:
 * the WebDAV provider uses a slash-separated collection path below the
 * configured remote root, another provider may use a workspace URI or a file
 * id. Consumers MUST NOT parse it or assume it is a local absolute path; they
 * build one with {@link drivePath} from a slash-separated relative path and
 * pass it back unchanged.
 */
export type DrivePath = Branded<'DrivePath'>

/**
 * Opaque revision token of one drive entry — the value a compare-and-set write
 * guards against. The WebDAV provider derives it from the entry's ETag when the
 * server supplies one and from its last-modified stamp and size otherwise.
 * Consumers MUST NOT interpret it; they compare tokens for equality and hand
 * the current one back to {@link NetworkDrive.write}.
 */
export type DriveVersion = Branded<'DriveVersion'>

/** What one drive entry is. `other` covers anything the drive can name but neither reads nor lists. */
export type DriveEntryType = 'file' | 'directory' | 'other'

/**
 * Metadata about one drive entry. Never carries content: a consumer decides
 * from `type` and `size` whether to transfer bytes at all.
 */
export interface DriveStat {
  /** The entry's own identity, as the drive reports it. */
  readonly path: DrivePath
  /** Whether the entry is a file, a directory, or neither. */
  readonly type: DriveEntryType
  /** Revision token of the entry right now. */
  readonly version: DriveVersion
  /** Byte size of a file; absent for a directory or when the drive omits it. */
  readonly size?: number
}

/** One direct child returned by {@link NetworkDrive.list}, in the order the drive reports it. */
export interface DriveDirEntry {
  /** Basename of the child inside the listed directory. */
  readonly name: string
  /** The child's own identity, for follow-up operations. */
  readonly path: DrivePath
  /** Whether the child is a file, a directory, or neither. */
  readonly type: DriveEntryType
  /** Revision token of the child right now. */
  readonly version: DriveVersion
  /** Byte size of a file child; absent for a directory or when the drive omits it. */
  readonly size?: number
}

/**
 * A half-open byte window of one file. `offset` is the first byte returned and
 * `length` the maximum number of bytes; the drive returns fewer only when the
 * file ends first.
 */
export interface DriveByteRange {
  /** Zero-based index of the first byte to return. */
  readonly offset: number
  /** Maximum number of bytes to return; must be positive. */
  readonly length: number
}

/** Bytes read from one file together with the revision they were read at. */
export interface DriveContent {
  /** The bytes the drive returned, at most `range.length` long when a range was given. */
  readonly bytes: Uint8Array
  /** Revision token the drive served these bytes at. */
  readonly version: DriveVersion
}

/**
 * Precondition on a {@link NetworkDrive.write}. `createIfAbsent` fails with
 * `DRIVE_PRECONDITION_FAILED` when the path already exists;
 * `replaceIfVersion` fails with the same code when the path is absent or holds
 * another revision. Omitting the precondition means unconditional
 * create-or-replace, not a third arm.
 */
export type DriveWriteIntent =
  | { readonly kind: 'createIfAbsent' }
  | { readonly kind: 'replaceIfVersion'; readonly version: DriveVersion }

/**
 * Stable, machine-routable codes for drive failures. A CLOSED union: consumers
 * `switch` on it ending in `assertNever`, so a new code breaks compilation at
 * every consumer until it is handled.
 */
export type DriveErrorCode =
  /** The path does not exist on the drive. */
  | 'DRIVE_NOT_FOUND'
  /** The path exists but is not the kind of entry the operation requires. */
  | 'DRIVE_NOT_DIRECTORY'
  /** The path exists but is not a file the operation can read or replace. */
  | 'DRIVE_NOT_FILE'
  /** The drive refused the operation for this identity. */
  | 'DRIVE_PERMISSION_DENIED'
  /** The credential the provider needs is unconfigured or rejected. */
  | 'DRIVE_UNAUTHENTICATED'
  /** A `createIfAbsent` or `replaceIfVersion` precondition did not hold. */
  | 'DRIVE_PRECONDITION_FAILED'
  /** The transfer would exceed the caller's byte bound. */
  | 'DRIVE_TOO_LARGE'
  /** The caller's `AbortSignal` fired. */
  | 'DRIVE_ABORTED'
  /** The drive or the transport failed for any other reason. */
  | 'DRIVE_IO_ERROR'
