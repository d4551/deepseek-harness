/**
 * Drive-backed provider for the filesystem capability seam. It projects one
 * `ctx.networkDrive` into `ctx.fs` through a local materialization root, so the
 * harness can run on a server whose session workspace lives on a network drive
 * while ripgrep, Bash, the terminal, the language servers, and the sandbox keep
 * seeing real local paths.
 *
 * Authority: the drive owns durable content. The materialization root is a
 * verified cache of it, plus the working directory the local execution world
 * writes into. A read serves the local copy only when that copy still hashes to
 * the digest recorded for the drive's current revision; a write publishes to the
 * drive first and updates the local copy only after the drive commits, so a
 * failed publish can never report success or leave the two sides diverged.
 *
 * @module @deepseek-ai/dsh-fs-network-drive
 */

import { createReadStream, mkdirSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox/roots'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { DriveError, driveChildPath, drivePath, driveParentPath } from '@deepseek-ai/dsh-network-drive/identity'
import type { NetworkDrive } from '@deepseek-ai/dsh-network-drive'
import type { DrivePath, DriveStat, DriveVersion, DriveWriteIntent } from '@deepseek-ai/dsh-network-drive/types'
import {
  digestOf,
  drivePathOf,
  localInfo,
  localPathOf,
  materialize,
  materializeDirectory,
  STATE_DIRECTORY,
  verifiedCopy,
} from './materialization.ts'
import type { LocalPathInfo } from './materialization.ts'
import {
  BINARY_SAMPLE_BYTES,
  decodeText,
  detectsCrlf,
  literalEdit,
  normalizeLineEndings,
  restoreLineEndings,
} from './text.ts'

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

interface SchemaResolvedConfig extends Config {
  remoteRoot: string
  maxFileBytes: number
}

interface ResolvedConfig {
  materializationRoot: string
  remoteRoot: DrivePath
  maxFileBytes: number
}

/** Where one target currently lives: on the drive, only in the local workspace, or nowhere. */
type Placement =
  | { readonly kind: 'drive'; readonly remote: DriveStat }
  | { readonly kind: 'local'; readonly info: LocalPathInfo; readonly version: FsVersion }
  | { readonly kind: 'absent' }

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

/**
 * Translate one drive failure into the filesystem seam's vocabulary. The drive
 * code union is closed, so a new drive code fails compilation here until it is
 * given a filesystem meaning.
 * @param error - the failure a drive operation raised.
 * @param operation - the filesystem operation name, for the message.
 * @param displayPath - the model-facing path the operation addressed.
 * @param signal - the caller's signal, which outranks the drive's classification.
 * @returns the typed filesystem error to raise.
 */
function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true) return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  if (!(error instanceof DriveError)) {
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
      return assertNever(error.code, 'drive error code')
  }
}

/** The seam version token naming one drive revision. */
function driveToken(version: DriveVersion): FsVersion {
  return FsVersion(`${DRIVE_VERSION_PREFIX}${version}`)
}

/** The seam version token naming local working content the drive does not hold. */
function localToken(digest: string): FsVersion {
  return FsVersion(`${LOCAL_VERSION_PREFIX}${digest}`)
}

/** Filesystem-level entry kind for one drive entry kind. */
function fsType(type: DriveStat['type']): FsInfo['type'] {
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

/** Filesystem-level entry kind for one local entry kind; a link is not a target kind. */
function fsTypeOfLocal(type: LocalPathInfo['type']): FsInfo['type'] {
  return type === 'file' || type === 'directory' ? type : 'other'
}

/**
 * Drive-backed filesystem. Injects the network drive and answers every seam
 * operation from it plus the local materialization root.
 */
export class NetworkDriveFileSystem extends FileSystem {
  static inject = ['networkDrive']

  static Config: z<Config> = z.object({
    materializationRoot: z.string(),
    remoteRoot: z.string().default(''),
    maxFileBytes: z.number().default(10 * 1024 * 1024),
  })

  /** Validated absolute local workspace the drive materializes into. */
  readonly materializationRoot: string

  private readonly config: ResolvedConfig
  private readonly locks = new Map<string, Promise<unknown>>()

  /** The injected drive; the declared injection is what makes this property present. */
  private get drive(): NetworkDrive {
    return this.ctx.networkDrive
  }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills the defaulted fields before construction; the input type does not encode that step.
    const resolved = config as SchemaResolvedConfig
    if (!isAbsolute(resolved.materializationRoot)) {
      throw new Error(
        `fs-network-drive: materializationRoot must be an absolute path, got ${JSON.stringify(resolved.materializationRoot)}`,
      )
    }
    if (!Number.isSafeInteger(resolved.maxFileBytes) || resolved.maxFileBytes < 1) {
      throw new Error('fs-network-drive: maxFileBytes must be a positive integer')
    }
    // The workspace exists before its identity is taken, and that identity is
    // the sandbox's own: `sandbox-policy` fences by the realpath, so a
    // materialization root left at its symlinked spelling would put every
    // process path outside the fence it is supposed to sit inside.
    const requested = resolve(resolved.materializationRoot)
    mkdirSync(requested, { recursive: true })
    this.config = {
      materializationRoot: resolve(canonicalPath(requested)),
      remoteRoot: drivePath(resolved.remoteRoot),
      maxFileBytes: resolved.maxFileBytes,
    }
    this.materializationRoot = this.config.materializationRoot
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    return this.targetOf(path, opts?.cwd, 'resolve')
  }

  override processPath(target: FsTarget): string {
    return localPathOf(this.config.materializationRoot, this.workspacePath(target))
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    // The execution world is this host, but this filesystem answers only for
    // the drive-backed workspace: naming a host file it cannot resolve, read,
    // or fence would hand a model a path its own file tools then reject.
    if (!isAbsolute(hostPath)) return undefined
    const canonical = resolve(hostPath)
    return drivePathOf(this.config.materializationRoot, canonical) === undefined ? undefined : canonical
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const placement = await this.placementOf(target, signal)
    switch (placement.kind) {
      case 'drive':
        return {
          version: driveToken(placement.remote.version),
          type: fsType(placement.remote.type),
          ...placement.remote.size === undefined ? {} : { size: placement.remote.size },
        }
      case 'local':
        return {
          version: placement.version,
          type: fsTypeOfLocal(placement.info.type),
          ...placement.info.size === undefined ? {} : { size: placement.info.size },
        }
      case 'absent':
        return undefined
      default:
        return assertNever(placement, 'placement')
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const target = this.targetOf(path, opts?.cwd, 'lstat')
    const local = await localInfo(this.processPath(target))
    // Only the local probe can see a link, and seeing one is the whole point of
    // lstat: report it before any drive lookup follows it to a target.
    if (local?.type === 'symlink') return { version: localToken('symlink'), type: 'symlink' }
    const placement = await this.placementOf(target, signal)
    switch (placement.kind) {
      case 'drive':
        return {
          version: driveToken(placement.remote.version),
          type: fsType(placement.remote.type),
          ...placement.remote.size === undefined ? {} : { size: placement.remote.size },
        }
      case 'local':
        return {
          version: placement.version,
          type: placement.info.type,
          ...placement.info.size === undefined ? {} : { size: placement.info.size },
        }
      case 'absent':
        return undefined
      default:
        return assertNever(placement, 'placement')
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const bytes = await this.hydrated(target, 'read', signal)
    return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const placement = await this.placementOf(target, signal)
    const size = placement.kind === 'drive' ? placement.remote.size : placement.kind === 'local' ? placement.info.size : undefined
    if (size !== undefined && size > maxBytes) {
      throw new FsError(
        `cannot read "${target.displayPath}": ${size} bytes exceeds the ${maxBytes}-byte limit`,
        'FS_TOO_LARGE',
      )
    }
    const bytes = await this.hydrated(target, 'read', signal, placement)
    if (bytes.byteLength > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // Hydration settles the local copy first, so the stream reads a file whose
    // bytes are already proven to match the drive revision it was opened for.
    await this.hydrated(target, 'read', signal)
    const localPath = this.processPath(target)
    const displayPath = target.displayPath
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampledBytes = 0
        const stream = createReadStream(localPath, signal === undefined ? {} : { signal })
        try {
          for await (const chunk of stream) {
            assertNotAborted(signal, 'read')
            const bytes = chunk as Uint8Array
            if (sampledBytes < BINARY_SAMPLE_BYTES) {
              const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampledBytes += sample.length
            }
            let text: string
            try {
              text = decoder.decode(bytes, { stream: true })
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
            if (text.length > 0) yield text
          }
          try {
            decoder.decode()
          } catch (error: unknown) {
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        } finally {
          stream.destroy()
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const placement = await this.placementOf(target, signal)
    if (placement.kind === 'absent') {
      throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    const type = placement.kind === 'drive' ? fsType(placement.remote.type) : fsTypeOfLocal(placement.info.type)
    if (type !== 'directory') {
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    }
    const workspacePath = this.workspacePath(target)
    const entries = new Map<string, FsDirEntry>()
    if (placement.kind === 'drive') {
      let listed
      try {
        listed = await this.drive.list(this.drivePathOfTarget(target), signal)
      } catch (error: unknown) {
        throw mapError(error, 'list', target.displayPath, signal)
      }
      for (const entry of listed) {
        const child = driveChildPath(workspacePath, entry.name)
        entries.set(entry.name, {
          name: entry.name,
          type: fsType(entry.type),
          target: this.targetFor(child),
          version: driveToken(entry.version),
          ...entry.size === undefined ? {} : { size: entry.size },
        })
      }
    }
    // Working files the local execution world created are listed beside the
    // drive's own children, so a shell-created file is visible before any seam
    // write has published it.
    await materializeDirectory(this.config.materializationRoot, workspacePath)
    for (const name of await this.localChildren(workspacePath)) {
      if (entries.has(name)) continue
      const child = driveChildPath(workspacePath, name)
      const info = await localInfo(localPathOf(this.config.materializationRoot, child))
      if (info === undefined) continue
      entries.set(name, {
        name,
        type: fsTypeOfLocal(info.type),
        target: this.targetFor(child),
        ...info.size === undefined ? {} : { size: info.size },
      })
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const placement = await this.placementOf(target, signal)
      this.checkWriteIntent(placement, expected, target)
      const before = await this.diffBasis(target, placement, signal)
      const version = await this.publish(target, placement, content, signal)
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
    return this.withLock(String(target.targetKey), async () => {
      const placement = await this.placementOf(target, signal)
      if (placement.kind === 'absent') {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const type = placement.kind === 'drive' ? fsType(placement.remote.type) : fsTypeOfLocal(placement.info.type)
      if (type !== 'file') {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && this.versionOf(placement) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = decodeText(
        await this.hydrated(target, 'edit', signal, placement),
        target.displayPath,
        Number.MAX_SAFE_INTEGER,
      )
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const version = await this.publish(target, placement, restoreLineEndings(after, detectsCrlf(raw)), signal)
      return { version, before, after }
    })
  }

  /** Serialize every mutation of one target, so guard, transfer, and publication share one critical section. */
  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  /** Build the target for one model-supplied path, rejecting anything outside the drive-backed workspace. */
  private targetOf(path: string, cwd: string | undefined, operation: string): FsTarget {
    const base = cwd === undefined ? this.config.materializationRoot : resolve(cwd)
    const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path)
    const within = drivePathOf(this.config.materializationRoot, absolute)
    if (within === undefined) {
      throw new FsError(
        `cannot ${operation} "${absolute}": the path is outside the network-drive workspace ${this.config.materializationRoot}`,
        'FS_PERMISSION_DENIED',
      )
    }
    return this.targetFor(drivePath(within))
  }

  /** The stable target for one workspace-relative drive path. */
  private targetFor(workspacePath: DrivePath): FsTarget {
    return {
      targetKey: FsTargetKey(targetKeyFor(workspacePath)),
      displayPath: localPathOf(this.config.materializationRoot, workspacePath),
    }
  }

  /** The workspace-relative drive path a target names; the provider owns its own key encoding. */
  private workspacePath(target: FsTarget): DrivePath {
    return drivePath(String(target.targetKey).slice(TARGET_KEY_PREFIX.length))
  }

  /** The absolute drive path a target names, below the configured remote root. */
  private drivePathOfTarget(target: FsTarget): DrivePath {
    const workspacePath = this.workspacePath(target)
    if (this.config.remoteRoot.length === 0) return workspacePath
    if (workspacePath.length === 0) return this.config.remoteRoot
    return drivePath(`${this.config.remoteRoot}/${workspacePath}`)
  }

  /** Where one target currently lives, consulting the drive first and the local workspace second. */
  private async placementOf(target: FsTarget, signal: AbortSignal | undefined): Promise<Placement> {
    assertNotAborted(signal, 'stat')
    let remote: DriveStat | undefined
    try {
      remote = await this.drive.stat(this.drivePathOfTarget(target), signal)
    } catch (error: unknown) {
      throw mapError(error, 'stat', target.displayPath, signal)
    }
    assertNotAborted(signal, 'stat')
    if (remote !== undefined) return { kind: 'drive', remote }
    const info = await localInfo(this.processPath(target))
    if (info === undefined) return { kind: 'absent' }
    return { kind: 'local', info, version: await this.localVersion(target, info) }
  }

  /** The seam version of one placement, which a guard compares against. */
  private versionOf(placement: Placement): FsVersion | undefined {
    switch (placement.kind) {
      case 'drive':
        return driveToken(placement.remote.version)
      case 'local':
        return placement.version
      case 'absent':
        return undefined
      default:
        return assertNever(placement, 'placement')
    }
  }

  /**
   * The version of a working entry the drive does not hold. A file's version is
   * its content digest, so an unpublished local edit changes it; anything else
   * has no content to digest and takes its kind as its version.
   */
  private async localVersion(target: FsTarget, info: LocalPathInfo): Promise<FsVersion> {
    if (info.type !== 'file') return localToken(info.type)
    if (info.size !== undefined && info.size > this.config.maxFileBytes) {
      return localToken(`oversize:${info.size}`)
    }
    const bytes = new Uint8Array(await readFile(this.processPath(target)))
    return localToken(digestOf(bytes))
  }

  /** Direct child names of one workspace directory, excluding the provider's private state. */
  private async localChildren(workspacePath: DrivePath): Promise<string[]> {
    const local = localPathOf(this.config.materializationRoot, workspacePath)
    const names = await readdir(local)
    return workspacePath.length === 0 ? names.filter(name => name !== STATE_DIRECTORY) : names
  }

  /**
   * The exact bytes of one target, transferring from the drive only when the
   * local copy cannot prove it already holds the drive's current revision.
   * A working file the drive does not hold is served from the workspace.
   */
  private async hydrated(
    target: FsTarget,
    operation: string,
    signal: AbortSignal | undefined,
    known?: Placement,
  ): Promise<Uint8Array> {
    const placement = known ?? await this.placementOf(target, signal)
    const workspacePath = this.workspacePath(target)
    if (placement.kind === 'absent') {
      throw new FsError(`cannot ${operation} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    if (placement.kind === 'local') {
      if (placement.info.type !== 'file') {
        throw new FsError(`cannot ${operation} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      return this.readLocal(target, operation)
    }
    if (fsType(placement.remote.type) !== 'file') {
      throw new FsError(`cannot ${operation} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (placement.remote.size !== undefined && placement.remote.size > this.config.maxFileBytes) {
      throw new FsError(
        `cannot ${operation} "${target.displayPath}": ${placement.remote.size} bytes exceeds the ${this.config.maxFileBytes}-byte materialization limit`,
        'FS_TOO_LARGE',
      )
    }
    if (await verifiedCopy(this.config.materializationRoot, workspacePath, placement.remote.version) !== undefined) {
      return this.readLocal(target, operation)
    }
    let bytes: Uint8Array
    try {
      // One byte past the ceiling proves an oversized file rather than
      // silently truncating it, and bounds the transfer at the same time.
      const content = await this.drive.read(
        this.drivePathOfTarget(target),
        { offset: 0, length: this.config.maxFileBytes + 1 },
        signal,
      )
      bytes = content.bytes
      if (bytes.byteLength > this.config.maxFileBytes) {
        throw new FsError(
          `cannot ${operation} "${target.displayPath}": content exceeds the ${this.config.maxFileBytes}-byte materialization limit`,
          'FS_TOO_LARGE',
        )
      }
      await materialize(this.config.materializationRoot, workspacePath, bytes, content.version)
    } catch (error: unknown) {
      throw mapError(error, operation, target.displayPath, signal)
    }
    return bytes
  }

  /** Read the materialized copy, reporting a vanished copy as the filesystem failure it is. */
  private async readLocal(target: FsTarget, operation: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.processPath(target)))
    } catch (error: unknown) {
      throw mapError(error, operation, target.displayPath)
    }
  }

  /** Reject a guarded write whose precondition no longer holds. */
  private checkWriteIntent(placement: Placement, expected: FsWriteIntent | undefined, target: FsTarget): void {
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
    if (this.versionOf(placement) !== expected.version) {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
  }

  /** The pre-write content a consumer diffs against, or null when there is none to offer. */
  private async diffBasis(
    target: FsTarget,
    placement: Placement,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    if (placement.kind === 'absent') return null
    try {
      return normalizeLineEndings(
        decodeText(await this.hydrated(target, 'write', signal, placement), target.displayPath, Number.MAX_SAFE_INTEGER),
      )
    } catch (error: unknown) {
      // A prior file this provider cannot represent as text yields no basis;
      // every other failure still owns the write.
      if (error instanceof FsError && (error.code === 'FS_NOT_TEXT' || error.code === 'FS_TOO_LARGE')) return null
      throw error
    }
  }

  /**
   * Publish new content: the drive commits first under a compare-and-set guard
   * derived from the placement the guard was checked against, and the local copy
   * is replaced only afterwards. A failed drive write therefore leaves the
   * workspace holding the previous content and raises.
   */
  private async publish(
    target: FsTarget,
    placement: Placement,
    content: string,
    signal: AbortSignal | undefined,
  ): Promise<FsVersion> {
    assertNotAborted(signal, 'write')
    const bytes = new TextEncoder().encode(content)
    if (bytes.byteLength > this.config.maxFileBytes) {
      throw new FsError(
        `cannot write "${target.displayPath}": ${bytes.byteLength} bytes exceeds the ${this.config.maxFileBytes}-byte materialization limit`,
        'FS_TOO_LARGE',
      )
    }
    const drivePathOfTarget = this.drivePathOfTarget(target)
    const intent: DriveWriteIntent = placement.kind === 'drive'
      ? { kind: 'replaceIfVersion', version: placement.remote.version }
      : { kind: 'createIfAbsent' }
    let version: DriveVersion
    try {
      const parent = driveParentPath(drivePathOfTarget)
      if (parent.length > 0) await this.drive.makeDirectory(parent, signal)
      version = await this.drive.write(drivePathOfTarget, bytes, intent, signal)
    } catch (error: unknown) {
      throw mapError(error, 'write', target.displayPath, signal)
    }
    await materialize(this.config.materializationRoot, this.workspacePath(target), bytes, version)
    return driveToken(version)
  }
}

export default NetworkDriveFileSystem
