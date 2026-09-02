/**
 * Shared harness for the drive-backed filesystem provider's specs: an in-memory
 * {@link NetworkDrive} with the seam's exact operations and no network, and the
 * context/materialization-root pair each spec boots the provider with.
 *
 * The fake subclasses the real Service Definition, so it registers itself as
 * `ctx.networkDrive` through the same constructor path a provider takes — no
 * cast, no provide-by-proxy.
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect } from 'vitest'
import { NetworkDrive } from '@deepseek-ai/dsh-network-drive'
import { DriveError, drivePath, driveVersion } from '@deepseek-ai/dsh-network-drive/identity'
import type {
  DriveByteRange,
  DriveContent,
  DriveDirEntry,
  DrivePath,
  DriveStat,
  DriveVersion,
  DriveWriteIntent,
} from '@deepseek-ai/dsh-network-drive/types'
import NetworkDriveFileSystem from '../src/index.ts'
import type { Config } from '../src/index.ts'

interface DriveNode {
  type: 'file' | 'directory'
  bytes: Uint8Array
  revision: number
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** In-memory drive with the seam's exact operations and no network. */
export class FakeDrive extends NetworkDrive {
  readonly nodes = new Map<string, DriveNode>([['', { type: 'directory', bytes: encode(''), revision: 0 }]])
  readonly reads: Array<{ path: string; range: DriveByteRange | undefined }> = []
  readonly writes: Array<{ path: string; content: string; expected: DriveWriteIntent | undefined }> = []
  readonly directories: string[] = []
  readonly signals: Array<AbortSignal | undefined> = []
  nextWriteError: Error | undefined
  nextReadError: Error | undefined
  onStat: (() => void) | undefined
  onWrite: (() => void) | undefined
  private clock = 1

  file(path: string, content: string): void {
    this.parents(path)
    this.nodes.set(path, { type: 'file', bytes: encode(content), revision: this.clock++ })
  }

  directory(path: string): void {
    this.parents(path)
    this.nodes.set(path, { type: 'directory', bytes: encode(''), revision: this.clock++ })
  }

  /** Another writer replacing the file behind the harness's back. */
  mutate(path: string, content: string): void {
    this.nodes.set(path, { type: 'file', bytes: encode(content), revision: this.clock++ })
  }

  contentOf(path: string): string | undefined {
    const node = this.nodes.get(path)
    return node === undefined ? undefined : new TextDecoder().decode(node.bytes)
  }

  private parents(path: string): void {
    const segments = path.split('/')
    for (let index = 0; index < segments.length - 1; index += 1) {
      const parent = segments.slice(0, index + 1).join('/')
      if (!this.nodes.has(parent)) this.nodes.set(parent, { type: 'directory', bytes: encode(''), revision: this.clock++ })
    }
  }

  private version(node: DriveNode): DriveVersion {
    return driveVersion(`rev-${node.revision}`)
  }

  private guard(operation: string, path: DrivePath, signal: AbortSignal | undefined): void {
    this.signals.push(signal)
    if (signal?.aborted === true) throw new DriveError(`${operation} "${path}" aborted`, 'DRIVE_ABORTED')
  }

  override async stat(path: DrivePath, signal?: AbortSignal): Promise<DriveStat | undefined> {
    this.guard('stat', path, signal)
    this.onStat?.()
    if (signal?.aborted === true) throw new DriveError(`stat "${path}" aborted`, 'DRIVE_ABORTED')
    const node = this.nodes.get(path)
    if (node === undefined) return undefined
    return {
      path,
      type: node.type,
      version: this.version(node),
      ...node.type === 'file' ? { size: node.bytes.byteLength } : {},
    }
  }

  override async list(path: DrivePath, signal?: AbortSignal): Promise<DriveDirEntry[]> {
    this.guard('list', path, signal)
    const node = this.nodes.get(path)
    if (node === undefined) throw new DriveError(`cannot list "${path}": not found`, 'DRIVE_NOT_FOUND')
    if (node.type !== 'directory') throw new DriveError(`cannot list "${path}": not a directory`, 'DRIVE_NOT_DIRECTORY')
    const entries: DriveDirEntry[] = []
    for (const [candidate, child] of this.nodes) {
      if (candidate === path || candidate === '') continue
      const cut = candidate.lastIndexOf('/')
      const parent = cut < 0 ? '' : candidate.slice(0, cut)
      if (parent !== path) continue
      const name = candidate.slice(cut + 1)
      entries.push({
        name,
        path: drivePath(candidate),
        type: child.type,
        version: this.version(child),
        ...child.type === 'file' ? { size: child.bytes.byteLength } : {},
      })
    }
    return entries
  }

  override async read(path: DrivePath, range: DriveByteRange | undefined, signal?: AbortSignal): Promise<DriveContent> {
    this.guard('read', path, signal)
    this.reads.push({ path, range })
    if (this.nextReadError !== undefined) {
      const error = this.nextReadError
      this.nextReadError = undefined
      throw error
    }
    const node = this.nodes.get(path)
    if (node === undefined) throw new DriveError(`cannot read "${path}": not found`, 'DRIVE_NOT_FOUND')
    if (node.type !== 'file') throw new DriveError(`cannot read "${path}": not a file`, 'DRIVE_NOT_FILE')
    const bytes = range === undefined
      ? node.bytes.slice()
      : node.bytes.slice(range.offset, range.offset + range.length)
    return { bytes, version: this.version(node) }
  }

  override async write(
    path: DrivePath,
    bytes: Uint8Array,
    expected: DriveWriteIntent | undefined,
    signal?: AbortSignal,
  ): Promise<DriveVersion> {
    this.guard('write', path, signal)
    this.onWrite?.()
    if (this.nextWriteError !== undefined) {
      const error = this.nextWriteError
      this.nextWriteError = undefined
      throw error
    }
    const existing = this.nodes.get(path)
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new DriveError(`cannot write "${path}": already present`, 'DRIVE_PRECONDITION_FAILED')
    }
    if (expected?.kind === 'replaceIfVersion' && (existing === undefined || this.version(existing) !== expected.version)) {
      throw new DriveError(`cannot write "${path}": another revision`, 'DRIVE_PRECONDITION_FAILED')
    }
    const node: DriveNode = { type: 'file', bytes: bytes.slice(), revision: this.clock++ }
    this.nodes.set(path, node)
    this.writes.push({ path, content: new TextDecoder().decode(bytes), expected })
    return this.version(node)
  }

  override async remove(path: DrivePath, signal?: AbortSignal): Promise<void> {
    this.guard('remove', path, signal)
    if (!this.nodes.delete(path)) throw new DriveError(`cannot remove "${path}": not found`, 'DRIVE_NOT_FOUND')
  }

  override async move(from: DrivePath, to: DrivePath, signal?: AbortSignal): Promise<void> {
    this.guard('move', from, signal)
    const node = this.nodes.get(from)
    if (node === undefined) throw new DriveError(`cannot move "${from}": not found`, 'DRIVE_NOT_FOUND')
    this.nodes.delete(from)
    this.nodes.set(to, node)
  }

  override async makeDirectory(path: DrivePath, signal?: AbortSignal): Promise<void> {
    this.guard('makeDirectory', path, signal)
    this.directories.push(path)
    if (path.length > 0 && !this.nodes.has(path)) this.directory(path)
  }
}

export interface Harness {
  ctx: Context
  fs: NetworkDriveFileSystem
  drive: FakeDrive
  root: string
}

const opened: Array<{ ctx: Context; root: string }> = []

afterEach(async () => {
  while (opened.length > 0) {
    const entry = opened.pop()!
    await entry.ctx.fiber.dispose()
    await rm(entry.root, { recursive: true, force: true })
  }
})

/**
 * Boot the provider over a fresh fake drive. Seeding runs before the plugin
 * mounts, matching the "seed the drive, then open the workspace" order.
 */
export async function setup(seed?: (drive: FakeDrive) => void, config: Partial<Config> = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-fs-network-drive-')))
  const ctx = new Context()
  opened.push({ ctx, root })
  const drive = new FakeDrive(ctx)
  if (seed !== undefined) seed(drive)
  await ctx.plugin(NetworkDriveFileSystem, { materializationRoot: root, ...config })
  return { ctx, fs: ctx.fs as NetworkDriveFileSystem, drive, root }
}

/** Assert one provider promise rejects with the exact filesystem failure code. */
export async function expectCode<T>(promise: Promise<T>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}
