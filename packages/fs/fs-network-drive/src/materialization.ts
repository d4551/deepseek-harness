/**
 * The local materialization store behind the drive-backed filesystem provider:
 * where one drive path lands on disk, how a cached copy proves it still holds
 * the bytes of a known drive revision, and how new bytes reach that path
 * atomically.
 *
 * Cache identity is content-verified, never timestamp-guessed. Every
 * materialized file has a record naming the drive revision it came from and the
 * sha256 of the exact bytes written; a cache hit requires both the recorded
 * revision to match the drive's current one and the file on disk to still hash
 * to the recorded digest. A file another writer replaced, truncated, or
 * corrupted therefore misses and is transferred again.
 *
 * @module @deepseek-ai/dsh-fs-network-drive/materialization
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { DrivePath, DriveVersion } from '@deepseek-ai/dsh-network-drive/types'

/** Directory inside the materialization root holding provider-private state. */
export const STATE_DIRECTORY = '.dsh-network-drive'

/** What one materialized file was hydrated from, and what it contained then. */
export interface MaterializationRecord {
  /** The drive revision these bytes were served at. */
  readonly version: DriveVersion
  /** Lowercase hex sha256 of the exact bytes written to the workspace path. */
  readonly digest: string
  /** Byte length of those bytes. */
  readonly bytes: number
}

/**
 * Lowercase hex sha256 of one byte string.
 * @param bytes - the exact content to digest.
 * @returns the 64-character lowercase hex digest.
 */
export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Where provider-private state lives for one materialization root.
 * @param materializationRoot - the absolute local workspace root.
 * @returns the absolute private state directory.
 */
export function stateRootOf(materializationRoot: string): string {
  return join(materializationRoot, STATE_DIRECTORY)
}

/**
 * The absolute local path one drive path materializes at.
 * @param materializationRoot - the absolute local workspace root.
 * @param path - the drive path, relative to the drive root.
 * @returns the absolute local path; the drive root is the materialization root itself.
 */
export function localPathOf(materializationRoot: string, path: DrivePath): string {
  return path.length === 0 ? materializationRoot : join(materializationRoot, ...path.split('/'))
}

/**
 * The drive path one absolute local path corresponds to, or `undefined` when
 * the local path lies outside the materialization root or inside the private
 * state directory.
 * @param materializationRoot - the absolute local workspace root.
 * @param localPath - an absolute local path.
 * @returns the slash-separated drive-relative path, or `undefined`.
 */
export function drivePathOf(materializationRoot: string, localPath: string): string | undefined {
  const within = relative(materializationRoot, resolve(localPath))
  if (within.startsWith('..') || within.startsWith(`..${sep}`)) return undefined
  const segments = within.split(sep).filter(segment => segment.length > 0)
  if (segments[0] === STATE_DIRECTORY) return undefined
  return segments.join('/')
}

/** The record file for one drive path: named by the digest of the path, so no path character can escape into a filename. */
function recordPath(materializationRoot: string, path: DrivePath): string {
  const key = createHash('sha256').update(path).digest('hex')
  return join(stateRootOf(materializationRoot), 'records', key.slice(0, 2), `${key}.json`)
}

/**
 * Read the record for one drive path.
 * @param materializationRoot - the absolute local workspace root.
 * @param path - the drive path whose record is wanted.
 * @returns the record, or `undefined` when none is stored or the stored record is unreadable.
 */
export async function readRecord(
  materializationRoot: string,
  path: DrivePath,
): Promise<MaterializationRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(recordPath(materializationRoot, path), 'utf8')
  } catch (_recordAbsent) {
    // A missing or unreadable record is exactly a cache miss; the caller
    // transfers the bytes again, which is the same outcome a stale record has.
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_recordUnparsable) {
    // The record file is durable state written by an earlier process, so it is
    // a parser boundary: a truncated write reads as a cache miss.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const candidate = parsed as Partial<Record<keyof MaterializationRecord, unknown>>
  if (typeof candidate.version !== 'string' || candidate.version === '') return undefined
  if (typeof candidate.digest !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.digest)) return undefined
  if (typeof candidate.bytes !== 'number' || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0) return undefined
  return { version: candidate.version as DriveVersion, digest: candidate.digest, bytes: candidate.bytes }
}

/**
 * Publish the record for one drive path, replacing any earlier one.
 * @param materializationRoot - the absolute local workspace root.
 * @param path - the drive path the record describes.
 * @param record - the revision and digest now on disk.
 */
export async function writeRecord(
  materializationRoot: string,
  path: DrivePath,
  record: MaterializationRecord,
): Promise<void> {
  const target = recordPath(materializationRoot, path)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await publishBytes(materializationRoot, target, new TextEncoder().encode(JSON.stringify(record)), 0o600)
}

/**
 * Drop the record for one drive path, so the next read transfers again.
 * @param materializationRoot - the absolute local workspace root.
 * @param path - the drive path whose record is stale.
 */
export async function dropRecord(materializationRoot: string, path: DrivePath): Promise<void> {
  await rm(recordPath(materializationRoot, path), { force: true })
}

/**
 * Whether the materialized copy of one drive path still holds the exact bytes
 * of a given drive revision. Both halves are checked: the record must name that
 * revision, and the file must still hash to the digest recorded with it.
 * @param materializationRoot - the absolute local workspace root.
 * @param path - the drive path to verify.
 * @param version - the drive revision the caller wants served.
 * @returns the verified byte length, or `undefined` when the copy cannot be trusted.
 */
export async function verifiedCopy(
  materializationRoot: string,
  path: DrivePath,
  version: DriveVersion,
): Promise<number | undefined> {
  const record = await readRecord(materializationRoot, path)
  if (record === undefined || record.version !== version) return undefined
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(localPathOf(materializationRoot, path)))
  } catch (_copyAbsentOrUnreadable) {
    // The workspace copy is gone or is no longer a readable regular file; the
    // caller transfers again, which is what a missing copy already means.
    return undefined
  }
  if (bytes.byteLength !== record.bytes || digestOf(bytes) !== record.digest) return undefined
  return bytes.byteLength
}

/**
 * Write bytes to an absolute local path atomically: a private staging file is
 * created exclusively, filled, synced, and renamed over the destination, so a
 * concurrent reader sees either the previous file or the complete new one.
 * @param materializationRoot - the absolute local workspace root owning the staging directory.
 * @param target - the absolute destination path; its parent must already exist.
 * @param bytes - the exact content to publish.
 * @param mode - permission bits for the published file.
 */
export async function publishBytes(
  materializationRoot: string,
  target: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  const staging = join(stateRootOf(materializationRoot), 'staging')
  await mkdir(staging, { recursive: true, mode: 0o700 })
  const temporary = join(staging, randomUUID())
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, target)
  } catch (error: unknown) {
    if (handle !== undefined) {
      await handle.close().catch(
        /* v8 ignore next -- reached only when the failing write also fails to close its own descriptor. */
        () => {},
      )
    }
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Materialize one drive path's bytes at its local path and record the revision
 * they came from, replacing whatever was there.
 * @param materializationRoot - the absolute local workspace root.
 * @param path - the drive path being materialized.
 * @param bytes - the exact bytes the drive served.
 * @param version - the drive revision those bytes belong to.
 */
export async function materialize(
  materializationRoot: string,
  path: DrivePath,
  bytes: Uint8Array,
  version: DriveVersion,
): Promise<void> {
  const target = localPathOf(materializationRoot, path)
  await mkdir(dirname(target), { recursive: true })
  await publishBytes(materializationRoot, target, bytes, 0o600)
  await writeRecord(materializationRoot, path, { version, digest: digestOf(bytes), bytes: bytes.byteLength })
}

/**
 * Ensure one drive directory exists locally, so a process in this execution
 * world can enter it.
 * @param materializationRoot - the absolute local workspace root.
 * @param path - the drive directory to create locally.
 */
export async function materializeDirectory(materializationRoot: string, path: DrivePath): Promise<void> {
  await mkdir(localPathOf(materializationRoot, path), { recursive: true })
}

/** Local metadata about one path without following a final symbolic link. */
export interface LocalPathInfo {
  /** What the path entry is on the local disk. */
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  /** Byte size of a regular file. */
  readonly size?: number
}

/**
 * Local metadata for one absolute path, without following a final symbolic link.
 * @param localPath - the absolute local path to inspect.
 * @returns the entry's kind and size, or `undefined` when nothing is there.
 */
export async function localInfo(localPath: string): Promise<LocalPathInfo | undefined> {
  let info
  try {
    info = await lstat(localPath)
  } catch (_localPathAbsent) {
    // Absence is the answer this probe reports; no other failure can reach a
    // caller that only distinguishes present from absent.
    return undefined
  }
  if (info.isSymbolicLink()) return { type: 'symlink' }
  if (info.isFile()) return { type: 'file', size: info.size }
  if (info.isDirectory()) return { type: 'directory' }
  return { type: 'other' }
}
