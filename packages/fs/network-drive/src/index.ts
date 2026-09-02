/**
 * Network-drive Service Definition for one remote byte store (`ctx.networkDrive`).
 * Providers own remote identity, revisions, directory structure, and byte transfer;
 * they own no local path, no text decoding, and no edit semantics.
 *
 * This is deliberately not a second filesystem. `ctx.fs` omits directory
 * creation, removal, and renaming because no model-facing tool needs them; a
 * drive-backed `ctx.fs` provider needs exactly those operations to keep a local
 * materialization and the remote in step, so they live here, one seam below.
 *
 * @module @deepseek-ai/dsh-network-drive
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  DriveByteRange,
  DriveContent,
  DriveDirEntry,
  DrivePath,
  DriveStat,
  DriveVersion,
  DriveWriteIntent,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    networkDrive: NetworkDrive
  }
}

/**
 * Abstract network-drive provider. Every operation takes the caller's
 * `AbortSignal` and must abandon its transfer when the signal fires, raising
 * `DRIVE_ABORTED`. Every failure is a `DriveError` carrying a closed-union
 * code; a provider never leaks its transport's own error type.
 *
 * Identity contract: a provider returns the same {@link DriveVersion} for an
 * unchanged entry and a different one after any content change, so a consumer
 * can use it as a compare-and-set token. Providers whose backing store cannot
 * distinguish two writes within one revision granularity must widen the token
 * with a value that can, never narrow it to a timestamp alone.
 */
export abstract class NetworkDrive extends Service {
  constructor(ctx: Context) {
    super(ctx, 'networkDrive')
  }

  /**
   * Return metadata for one path, or `undefined` when the drive holds nothing
   * there.
   * @param path - the entry to inspect.
   * @param signal - aborts the metadata round-trip.
   * @returns the entry's metadata, never its content; `undefined` when absent.
   */
  abstract stat(path: DrivePath, signal?: AbortSignal): Promise<DriveStat | undefined>

  /**
   * List the direct children of one directory.
   * @param path - the directory to list; `drivePath('')` is the drive root.
   * @param signal - aborts the listing.
   * @returns one entry per direct child; never reads child content.
   * @throws DriveError `DRIVE_NOT_FOUND` when absent, `DRIVE_NOT_DIRECTORY` when the path is a file.
   */
  abstract list(path: DrivePath, signal?: AbortSignal): Promise<DriveDirEntry[]>

  /**
   * Read raw bytes of one file. Omitting `range` reads the whole file; a range
   * reads at most `range.length` bytes starting at `range.offset`, which is how
   * a consumer bounds a transfer before it commits memory to it.
   * @param path - the file to read.
   * @param range - the byte window to transfer; omit for the whole file.
   * @param signal - aborts the transfer.
   * @returns the bytes and the revision they were served at.
   * @throws DriveError `DRIVE_NOT_FOUND` when absent, `DRIVE_NOT_FILE` for a directory.
   */
  abstract read(path: DrivePath, range: DriveByteRange | undefined, signal?: AbortSignal): Promise<DriveContent>

  /**
   * Replace or create one file's complete content. The write is the drive's
   * commit point: it either publishes every byte or leaves the previous
   * revision in place.
   * @param path - the file to write; its parent directory must already exist.
   * @param bytes - the complete new content.
   * @param expected - the compare-and-set precondition; omit for an unconditional write.
   * @param signal - aborts before the drive publishes the new revision.
   * @returns the revision the write produced.
   * @throws DriveError `DRIVE_PRECONDITION_FAILED` when `expected` does not hold.
   */
  abstract write(
    path: DrivePath,
    bytes: Uint8Array,
    expected: DriveWriteIntent | undefined,
    signal?: AbortSignal,
  ): Promise<DriveVersion>

  /**
   * Remove one entry. Removing a directory removes its descendants.
   * @param path - the entry to remove.
   * @param signal - aborts the removal.
   * @throws DriveError `DRIVE_NOT_FOUND` when the path holds nothing.
   */
  abstract remove(path: DrivePath, signal?: AbortSignal): Promise<void>

  /**
   * Move one entry to another path, replacing whatever the destination held.
   * Providers implement it as one remote operation so a consumer can publish a
   * staged file without a read-write window.
   * @param from - the entry to move.
   * @param to - the destination path; its parent directory must already exist.
   * @param signal - aborts the move.
   * @throws DriveError `DRIVE_NOT_FOUND` when the source holds nothing.
   */
  abstract move(from: DrivePath, to: DrivePath, signal?: AbortSignal): Promise<void>

  /**
   * Create one directory and every missing ancestor below the drive root.
   * Succeeds when the directory already exists, so a consumer can make a parent
   * ready without a preceding probe.
   * @param path - the directory to create.
   * @param signal - aborts the creation.
   * @throws DriveError `DRIVE_NOT_DIRECTORY` when the path or an ancestor is a file.
   */
  abstract makeDirectory(path: DrivePath, signal?: AbortSignal): Promise<void>
}

export default NetworkDrive
