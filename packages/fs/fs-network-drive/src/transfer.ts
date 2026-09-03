/**
 * Drive transfers: hydration of drive content into the local workspace and
 * publication of new content back to the drive, both bounded by the
 * materialization limit and committed drive-first under compare-and-set guards.
 *
 * Every drive or filesystem failure settles into a {@link Landed} value whose
 * rejection side carries the failure as an `Error`, then translates through
 * `mapError`; no catch block ever widens a failure to a bare parameter.
 *
 * @module @deepseek-ai/dsh-fs-network-drive/transfer
 */

import { createReadStream } from 'node:fs'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { BINARY_SAMPLE_BYTES, decodeText, decodeTextStream, normalizeLineEndings } from '@deepseek-ai/dsh-fs/text'
import { driveParentPath } from '@deepseek-ai/dsh-network-drive/identity'
import type { NetworkDrive } from '@deepseek-ai/dsh-network-drive'
import type { DriveContent, DriveVersion, DriveWriteIntent } from '@deepseek-ai/dsh-network-drive/types'
import { materialize, readBounded, verifiedCopy } from './materialization.ts'
import type { DriveAddressing, ResolvedConfig } from './addressing.ts'
import { assertNotAborted, driveToken, fsType, fsTypeOfLocal, landing, mapError } from './vocabulary.ts'
import type { Placement } from './vocabulary.ts'

/**
 * One drive-backed transfer: hydration and publication across the addressing
 * mappings. Holds no locks; the provider serializes mutations.
 */
export class DriveTransfer {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly addressing: DriveAddressing,
    private readonly drive: () => NetworkDrive,
  ) {}

  /**
   * The failure one transfer over the materialization ceiling raises, in the
   * single wording every direction and side reports it with.
   * @param operation - the seam operation name the message opens with.
   * @param target - the target being transferred.
   * @param measure - what exceeded the ceiling: `"<n> bytes"` when a size was
   * reported ahead of the transfer, `"content"` when the bytes themselves did.
   * @returns the `FS_TOO_LARGE` failure to raise.
   */
  private tooLarge(operation: string, target: FsTarget, measure: string): FsError {
    return new FsError(
      `cannot ${operation} "${target.displayPath}": ${measure} exceeds the ${this.config.maxFileBytes}-byte materialization limit`,
      'FS_TOO_LARGE',
    )
  }

  /**
   * The exact bytes of one target, transferring from the drive only when the
   * local copy cannot prove it already holds the drive's current revision.
   * A working file the drive does not hold is served from the workspace.
   * @param target - the file to read.
   * @param operation - the seam operation name (`read`, `write`, `edit`) quoted
   * in every failure message this raises.
   * @param signal - the caller's signal, passed to the drive read. Once bytes
   * arrive they are materialized and returned with no further abort check.
   * @param known - a placement the caller already read, reused instead of a
   * second placement read. It MUST be the placement the caller's guard was
   * checked against, read under the same write lock; a stale one serves bytes
   * that no longer match the version the caller reported.
   * @returns the file's current bytes: from the local copy when its record and
   * digest still prove the drive's revision, otherwise from a fresh transfer that
   * is materialized before it returns.
   * @throws FsError `FS_NOT_FOUND` when the target is absent,
   * `FS_NOT_REGULAR_FILE` when it is not a file, `FS_TOO_LARGE` when a reported
   * size or the content itself exceeds `maxFileBytes` — the ceiling bounds a
   * working file the local execution world created exactly as it bounds a drive
   * transfer — or the drive failure `mapError` translated.
   */
  async hydrated(
    target: FsTarget,
    operation: string,
    signal: AbortSignal | undefined,
    known?: Placement,
  ): Promise<Uint8Array> {
    const placement = known ?? await this.addressing.placementOf(target, signal)
    if (placement.kind === 'absent') {
      throw new FsError(`cannot ${operation} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    if (placement.kind === 'local') {
      if (placement.info.type !== 'file') {
        throw new FsError(`cannot ${operation} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (placement.info.size !== undefined && placement.info.size > this.config.maxFileBytes) {
        throw this.tooLarge(operation, target, `${placement.info.size} bytes`)
      }
      return this.readLocal(target, operation)
    }
    if (fsType(placement.remote.type) !== 'file') {
      throw new FsError(`cannot ${operation} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (placement.remote.size !== undefined && placement.remote.size > this.config.maxFileBytes) {
      throw this.tooLarge(operation, target, `${placement.remote.size} bytes`)
    }
    if (await verifiedCopy(
      this.config.materializationRoot,
      this.addressing.workspacePath(target),
      placement.remote.version,
    ) !== undefined) {
      return this.readLocal(target, operation)
    }
    // One byte past the ceiling proves an oversized file rather than
    // silently truncating it, and bounds the transfer at the same time.
    const transferred = await landing<DriveContent>(
      this.drive().read(this.addressing.drivePathOfTarget(target), { offset: 0, length: this.config.maxFileBytes + 1 }, signal),
    )
    if (!transferred.ok) throw mapError(transferred.reason, operation, target.displayPath, signal)
    const bytes = transferred.value.bytes
    if (bytes.byteLength > this.config.maxFileBytes) throw this.tooLarge(operation, target, 'content')
    const stored = await landing<void>(
      materialize(this.config.materializationRoot, this.addressing.workspacePath(target), bytes, transferred.value.version),
    )
    if (!stored.ok) throw mapError(stored.reason, operation, target.displayPath, signal)
    return bytes
  }

  /**
   * Read the materialized copy under the materialization ceiling, reporting a
   * vanished copy as the filesystem failure it is.
   * @param target - the target whose workspace copy to read.
   * @param operation - the seam operation name quoted in the failure message.
   * @returns the bytes on disk at the target's process path, with no freshness
   * check of its own: the caller has already established that this copy is the
   * one to serve. The read stops one byte past `maxFileBytes`, so the ceiling
   * bounds what this holds even when the size the caller measured is no longer
   * the size on disk — the workspace is shared with the local execution world,
   * whose writes this provider does not serialize, and a materialization root
   * outlives the ceiling any one session was configured with.
   * @throws FsError `FS_NOT_FOUND` when the copy is gone, `FS_TOO_LARGE` when it
   * exceeds `maxFileBytes`, or `FS_IO_ERROR` for any other read failure; a copy
   * the caller just proved current reaches these only through interference from
   * outside this provider.
   */
  async readLocal(target: FsTarget, operation: string): Promise<Uint8Array> {
    const file = await landing<Uint8Array>(
      readBounded(this.addressing.processPath(target), this.config.maxFileBytes),
    )
    if (!file.ok) throw mapError(file.reason, operation, target.displayPath)
    if (file.value.byteLength > this.config.maxFileBytes) throw this.tooLarge(operation, target, 'content')
    return file.value
  }

  /**
   * The decoded text of one target, after hydration proves the local copy current.
   * @param target - the file to read.
   * @param signal - the caller's signal, honored by the placement read and the transfer.
   * @returns the whole file decoded as UTF-8, in its own line endings; nothing is
   * normalized on the read path.
   * @throws FsError `FS_NOT_TEXT` when the first {@link BINARY_SAMPLE_BYTES}
   * bytes contain NUL or the content is not valid UTF-8, plus every failure
   * {@link DriveTransfer.hydrated} raises.
   *
   * A NUL past that leading sample does not reject the read. The sample is the
   * seam's own binary test — `fs-local` reads the same one — and it is what a
   * caller asking for this file's text gets to decide with;
   * {@link DriveTransfer.diffBasis} deliberately judges the whole file instead.
   */
  async readText(target: FsTarget, signal: AbortSignal | undefined): Promise<string> {
    return decodeText(await this.hydrated(target, 'read', signal), target.displayPath, BINARY_SAMPLE_BYTES)
  }

  /**
   * The text of one target as an iterable, reading the hydrated local copy.
   * Iteration, early consumer exit, and failure all release the file handle.
   * @param target - the file to stream.
   * @param signal - the caller's signal; it aborts the read stream and is
   * rechecked between chunks.
   * @returns an iterable over decoded UTF-8 chunks of the copy hydration settled
   * before this returned. Each iteration opens its own handle, so the value can be
   * consumed more than once; a revision published to the drive afterwards is not
   * picked up, because hydration ran once, ahead of the first chunk.
   * @throws FsError `FS_NOT_TEXT` on binary or invalid UTF-8 content and
   * `FS_ABORTED` when the signal fires mid-iteration, both from the iterator
   * rather than from this call, plus every failure {@link DriveTransfer.hydrated} raises.
   */
  async textStream(target: FsTarget, signal: AbortSignal | undefined): Promise<AsyncIterable<string>> {
    // Hydration settles the local copy first, so the stream reads a file whose
    // bytes are already proven to match the drive revision it was opened for.
    await this.hydrated(target, 'read', signal)
    const localPath = this.addressing.processPath(target)
    const displayPath = target.displayPath
    return {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        const stream = createReadStream(localPath, signal === undefined ? {} : { signal })
        async function* byteChunks(): AsyncGenerator<Uint8Array> {
          for await (const chunk of stream) {
            assertNotAborted(signal, 'read')
            yield chunk as Uint8Array
          }
        }
        const text = decodeTextStream(byteChunks(), displayPath, BINARY_SAMPLE_BYTES)[Symbol.asyncIterator]()
        const release = (): void => {
          stream.destroy()
        }
        return {
          async next(): Promise<IteratorResult<string>> {
            const step = await landing<IteratorResult<string>>(text.next())
            if (!step.ok) {
              release()
              throw mapError(step.reason, 'read', displayPath, signal)
            }
            if (step.value.done) release()
            return step.value
          },
          async return(): Promise<IteratorResult<string>> {
            release()
            return text.return(undefined)
          },
          async throw(reason?: Error): Promise<IteratorResult<string>> {
            release()
            return text.throw(reason)
          },
        }
      },
    }
  }

  /**
   * Reject a guarded write whose precondition no longer holds.
   * @param placement - the placement read for this write, under the lock that
   * will publish it; the guard is only as fresh as this value.
   * @param expected - the caller's precondition; `undefined` means unconditional
   * create-or-overwrite, which still rejects a target that is not a file.
   * @param target - the target being written, named in the failure messages.
   * @throws FsError `FS_NOT_REGULAR_FILE` when the target exists and is not a
   * file, `FS_NOT_OBSERVED` when `createIfAbsent` meets an existing target, and
   * `FS_STALE_VERSION` when `replaceIfVersion` does not equal the placement's
   * version, including when the target is absent.
   */
  checkWriteIntent(placement: Placement, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (placement.kind !== 'absent') {
      const type = placement.kind === 'drive' ? fsType(placement.remote.type) : fsTypeOfLocal(placement.info.type)
      if (type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
    }
    if (expected === undefined) return
    if (expected.kind === 'createIfAbsent') {
      if (placement.kind !== 'absent') {
        throw new FsError(
          `cannot overwrite existing "${target.displayPath}" without reading it first`,
          'FS_NOT_OBSERVED',
        )
      }
      return
    }
    if (this.addressing.versionOf(placement) !== expected.version) {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
  }

  /**
   * The pre-write content a consumer diffs against, or null when there is none to offer.
   * @param target - the file about to be replaced.
   * @param placement - the placement the write was guarded against, reused as the
   * hydration input so no second drive stat runs.
   * @param signal - the caller's signal, honored during hydration.
   * @returns the prior content, LF-normalized so it shares a diff basis with the
   * text being written, or `null` when the target is absent, exceeds
   * `maxFileBytes`, or is not text — judged over the whole file here, not over the
   * leading sample {@link DriveTransfer.readText} inspects. The two must differ:
   * a basis is offered rather than asked for, so a NUL deeper in the file costs
   * only the basis here, while widening the read's sample would make every read
   * scan every byte to refuse a file the seam calls text. Declining a basis never
   * fails the write; every other failure propagates and does.
   */
  async diffBasis(target: FsTarget, placement: Placement, signal: AbortSignal | undefined): Promise<string | null> {
    if (placement.kind === 'absent') return null
    // Every failure this composes has already been translated to an FsError.
    const basis = await landing<string>(
      this.hydrated(target, 'write', signal, placement)
        .then(bytes => decodeText(bytes, target.displayPath, Number.MAX_SAFE_INTEGER)),
    )
    if (basis.ok) return normalizeLineEndings(basis.value)
    // A prior file this provider cannot represent as text yields no basis;
    // every other failure still owns the write.
    if (basis.reason instanceof FsError && (basis.reason.code === 'FS_NOT_TEXT' || basis.reason.code === 'FS_TOO_LARGE')) return null
    throw basis.reason
  }

  /**
   * Publish new content: the drive commits first under a compare-and-set guard
   * derived from the placement the guard was checked against, and the local copy
   * is replaced only afterwards. A failed drive write therefore leaves the
   * workspace holding the previous content and raises. Any missing drive parent
   * is created first and stays if the write then fails.
   * @param target - the file to publish.
   * @param placement - the placement {@link DriveTransfer.checkWriteIntent}
   * approved. A `drive` placement becomes a `replaceIfVersion` precondition on its
   * revision, anything else a `createIfAbsent`. This method re-checks nothing, so
   * the caller holds the target's write lock across both calls.
   * @param content - the text to store; it is encoded as UTF-8, and that encoded
   * length, not the string length, is what `maxFileBytes` bounds.
   * @param signal - the caller's signal, checked once before any work and passed
   * to the drive calls. Nothing already committed is undone: a write the drive
   * accepted stands, and publication finishes and returns even when the signal
   * fires meanwhile. Should the local copy then fail to update, the drive holds
   * the new revision while the workspace still holds the previous bytes.
   * @returns the `drive:` token of the revision the drive assigned to this
   * content — the version the seam reports for the file after the write, and the
   * one a later guarded write must present.
   * @throws FsError `FS_TOO_LARGE` when the encoded content exceeds
   * `maxFileBytes`, `FS_STALE_VERSION` when the drive rejects the precondition, or
   * the drive or materialization failure `mapError` translated.
   */
  async publish(
    target: FsTarget,
    placement: Placement,
    content: string,
    signal: AbortSignal | undefined,
  ): Promise<FsVersion> {
    assertNotAborted(signal, 'write')
    const bytes = new TextEncoder().encode(content)
    if (bytes.byteLength > this.config.maxFileBytes) throw this.tooLarge('write', target, `${bytes.byteLength} bytes`)
    const drivePath = this.addressing.drivePathOfTarget(target)
    const intent: DriveWriteIntent = placement.kind === 'drive'
      ? { kind: 'replaceIfVersion', version: placement.remote.version }
      : { kind: 'createIfAbsent' }
    const parent = driveParentPath(drivePath)
    if (parent.length > 0) {
      const made = await landing<void>(this.drive().makeDirectory(parent, signal))
      if (!made.ok) throw mapError(made.reason, 'write', target.displayPath, signal)
    }
    const written = await landing<DriveVersion>(
      this.drive().write(drivePath, bytes, intent, signal),
    )
    if (!written.ok) throw mapError(written.reason, 'write', target.displayPath, signal)
    const stored = await landing<void>(
      materialize(this.config.materializationRoot, this.addressing.workspacePath(target), bytes, written.value),
    )
    if (!stored.ok) throw mapError(stored.reason, 'write', target.displayPath, signal)
    return driveToken(written.value)
  }
}
