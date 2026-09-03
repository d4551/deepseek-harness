/**
 * Network-drive-backed filesystem provider: materializes one remote drive into
 * a local workspace root and serves the filesystem seam from it. Target
 * addressing, placement, and listing live in `./addressing.ts`; hydration and
 * publication transfers live in `./transfer.ts`. This module holds the seam
 * surface and its write serialization.
 *
 * @module @deepseek-ai/dsh-fs-network-drive
 */

import { mkdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox/roots'
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import { KeyedLock } from '@deepseek-ai/dsh-keyed-lock'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { decodeText, detectsCrlf, literalEdit, normalizeLineEndings, restoreLineEndings } from '@deepseek-ai/dsh-fs/text'
import type { NetworkDrive } from '@deepseek-ai/dsh-network-drive'
import { drivePath } from '@deepseek-ai/dsh-network-drive/identity'
import { DriveAddressing, infoOfPlacement } from './addressing.ts'
import type { ResolvedConfig } from './addressing.ts'
import { drivePathOf, localInfo } from './materialization.ts'
import { DriveTransfer } from './transfer.ts'
import { assertNotAborted, fsTypeOfLocal, localToken } from './vocabulary.ts'

/** Configuration for the drive-backed filesystem provider. */
export interface Config {
  /**
   * Absolute local directory the drive materializes into. It is the workspace
   * every spawned process sees, and it must be the same directory the sandbox
   * policy fences by.
   */
  materializationRoot: string
  /** Slash-separated drive path whose subtree the materialization root mirrors; omitted mirrors the drive root. */
  remoteRoot?: string
  /** Byte ceiling on one file this provider will transfer in either direction. */
  maxFileBytes?: number
}

/**
 * A filesystem provider backed by one network drive. Reads materialize drive
 * content into a local workspace root and serve it from there; writes commit
 * to the drive first under a compare-and-set guard, then refresh the local
 * copy. Per-target locks serialize a target's writes; the drive itself is the
 * cross-process consistency authority.
 */
export class NetworkDriveFileSystem extends FileSystem {
  static readonly inject = ['networkDrive']

  /** Workspace root and transfer bounds, validated at load. */
  static Config: z<Config> = z.object({
    materializationRoot: z.string().role('filepath').required().description('Local directory the drive materializes into'),
    maxFileBytes: z.number().default(50 * 1024 * 1024).description('Largest file this provider transfers or stores'),
    remoteRoot: z.string().default('').description('Slash-separated path on the drive mapping to the workspace root'),
  })

  /** The validated materialization root, for the observation invariant. */
  readonly materializationRoot: string
  private readonly addressing: DriveAddressing
  private readonly transfer: DriveTransfer
  private readonly writes = new KeyedLock()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // schemastery applied every default before construction, so the optional
    // members of Config are present here.
    const defaulted = config as Required<Config>
    if (!isAbsolute(defaulted.materializationRoot)) {
      throw new Error(
        `fs-network-drive: materializationRoot must be an absolute path, got ${JSON.stringify(defaulted.materializationRoot)}`,
      )
    }
    if (!Number.isSafeInteger(defaulted.maxFileBytes) || defaulted.maxFileBytes < 1) {
      throw new Error('fs-network-drive: maxFileBytes must be a positive integer')
    }
    // The workspace exists before its identity is taken, and that identity is
    // the sandbox's own: `sandbox-policy` fences by the realpath, so a
    // materialization root left at its symlinked spelling would put every
    // process path outside the fence it is supposed to sit inside.
    const requested = resolve(defaulted.materializationRoot)
    mkdirSync(requested, { recursive: true })
    const root = resolve(canonicalPath(requested))
    this.materializationRoot = root
    const resolved: ResolvedConfig = {
      materializationRoot: root,
      remoteRoot: drivePath(defaulted.remoteRoot),
      maxFileBytes: defaulted.maxFileBytes,
    }
    const drive = (): NetworkDrive => ctx.networkDrive
    this.addressing = new DriveAddressing(resolved, drive)
    this.transfer = new DriveTransfer(resolved, this.addressing, drive)
  }

  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    // Addressing is synchronous, but the seam declares `resolve`
    // promise-returning and every caller awaits it, so a rejected path has to
    // settle the returned promise. A synchronous throw escapes a `.catch()` on
    // the result; `identity.spec.ts` pins that a blocked path rejects.
    try {
      assertNotAborted(opts?.signal, 'resolve')
      if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
      return Promise.resolve(this.addressing.targetOf(path, opts?.cwd, 'resolve'))
    } catch (rejection: unknown) {
      // Everything thrown above is an `FsError`; `assertNotAborted` and the
      // empty-path guard construct one, and `targetOf` throws only `FsError`.
      return Promise.reject(rejection instanceof Error
        ? rejection
        : new FsError(`cannot resolve "${path}"`, 'FS_PERMISSION_DENIED', { cause: rejection }))
    }
  }

  override processPath(target: FsTarget): string {
    return this.addressing.processPath(target)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    // The execution world is this host, but this filesystem answers only for
    // the drive-backed workspace: naming a host file it cannot resolve, read,
    // or fence would hand a model a path its own file tools then reject.
    if (!isAbsolute(hostPath)) return undefined
    const canonical = resolve(hostPath)
    return drivePathOf(this.materializationRoot, canonical) === undefined ? undefined : canonical
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const placement = await this.addressing.placementOf(target, signal)
    return infoOfPlacement(placement, fsTypeOfLocal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const target = this.addressing.targetOf(path, opts?.cwd, 'lstat')
    const local = await localInfo(this.addressing.processPath(target))
    // Only the local probe can see a link, and seeing one is the whole point of
    // lstat: report it before any drive lookup follows it to a target.
    if (local?.type === 'symlink') return { version: localToken('symlink'), type: 'symlink' }
    const placement = await this.addressing.placementOf(target, signal)
    return infoOfPlacement(placement, localType => localType)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.transfer.readText(target, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const placement = await this.addressing.placementOf(target, signal)
    const size = placement.kind === 'drive' ? placement.remote.size : placement.kind === 'local' ? placement.info.size : undefined
    if (size !== undefined && size > maxBytes) {
      throw new FsError(
        `cannot read "${target.displayPath}": ${size} bytes exceeds the ${maxBytes}-byte limit`,
        'FS_TOO_LARGE',
      )
    }
    const bytes = await this.transfer.hydrated(target, 'read', signal, placement)
    if (bytes.byteLength > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.transfer.textStream(target, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.addressing.listEntries(target, signal)
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.writes.run(String(target.targetKey), async () => {
      const placement = await this.addressing.placementOf(target, signal)
      this.transfer.checkWriteIntent(placement, expected, target)
      const before = await this.transfer.diffBasis(target, placement, signal)
      const version = await this.transfer.publish(target, placement, content, signal)
      return {
        operation: placement.kind === 'absent' ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.writes.run(String(target.targetKey), async () => {
      const placement = await this.addressing.placementOf(target, signal)
      if (placement.kind === 'absent') {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      this.transfer.checkWriteIntent(placement, expected && { kind: 'replaceIfVersion', version: expected.version }, target)
      const raw = decodeText(
        await this.transfer.hydrated(target, 'edit', signal, placement),
        target.displayPath,
        Number.MAX_SAFE_INTEGER,
      )
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const version = await this.transfer.publish(target, placement, restoreLineEndings(after, detectsCrlf(raw)), signal)
      return { version, before, after }
    })
  }

}

export default NetworkDriveFileSystem
