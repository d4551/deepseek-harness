/**
 * Runtime half of the network-drive vocabulary: the brand constructors for
 * remote-path and revision identity, the path normalizer every provider shares,
 * and the typed error class that carries a {@link DriveErrorCode}.
 *
 * These live beside `./types.ts` rather than inside it because that module is
 * types only, and beside the service class rather than inside it because a
 * consumer that raises or classifies a drive failure must not import the
 * abstract service to do it.
 *
 * @module @deepseek-ai/dsh-network-drive/identity
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { DriveErrorCode, DrivePath, DriveVersion } from './types.ts'

/** Path segments a drive path may never contain, because they would escape the remote root. */
const TRAVERSAL_SEGMENTS = new Set(['', '.', '..'])

/**
 * Brand a slash-separated relative path as a {@link DrivePath}. The empty
 * string names the drive root. Rejects absolute paths, backslashes, `.`/`..`
 * segments, and NUL, so no consumer-supplied path can address anything above
 * the provider's configured remote root.
 * @param value - slash-separated path relative to the drive root, `''` for the root itself.
 * @returns the normalized path, branded.
 * @throws TypeError when the value cannot name an entry below the drive root.
 */
export function drivePath(value: string): DrivePath {
  if (value.includes('\0')) throw new TypeError('drive path must not contain NUL')
  if (value.includes('\\')) throw new TypeError(`drive path must use "/" separators: ${JSON.stringify(value)}`)
  if (value.startsWith('/')) throw new TypeError(`drive path must be relative to the drive root: ${JSON.stringify(value)}`)
  if (value === '') return '' as DrivePath
  const segments = value.split('/')
  for (const segment of segments) {
    if (TRAVERSAL_SEGMENTS.has(segment)) {
      throw new TypeError(`drive path segment ${JSON.stringify(segment)} is not addressable: ${JSON.stringify(value)}`)
    }
  }
  return segments.join('/') as DrivePath
}

/**
 * Join one drive path with a child basename.
 * @param parent - the parent drive path; `''` is the drive root.
 * @param name - the child's basename, validated as one path segment.
 * @returns the child's branded drive path.
 * @throws TypeError when `name` is not a single addressable segment.
 */
export function driveChildPath(parent: DrivePath, name: string): DrivePath {
  if (name.includes('/')) throw new TypeError(`drive child name must be one segment: ${JSON.stringify(name)}`)
  return drivePath(parent === '' ? name : `${parent}/${name}`)
}

/**
 * The parent of one drive path.
 * @param path - the drive path whose parent is required.
 * @returns the parent path; the drive root's parent is the drive root.
 */
export function driveParentPath(path: DrivePath): DrivePath {
  const cut = path.lastIndexOf('/')
  return (cut < 0 ? '' : path.slice(0, cut)) as DrivePath
}

/**
 * Brand a provider-supplied revision string as a {@link DriveVersion}. For
 * provider use only — a consumer never manufactures a version, it receives one
 * from `stat`, `list`, `read`, or `write`.
 * @param value - the provider's raw revision string; must be non-empty.
 * @returns the same string, branded.
 * @throws TypeError when the value is empty, which would compare equal to a missing revision.
 */
export function driveVersion(value: string): DriveVersion {
  if (value === '') throw new TypeError('drive version must be a non-empty string')
  return value as DriveVersion
}

/**
 * Typed network-drive error. Extends {@link HarnessError} so it carries a
 * stable {@link DriveErrorCode} and chains `cause`. The Service Definition owns
 * this vocabulary so every provider raises the same codes instead of each
 * inventing message strings.
 */
export class DriveError extends HarnessError {
  override readonly code: DriveErrorCode

  /**
   * @param message - operator-facing description naming the operation and path.
   * @param code - the closed-union code consumers route on.
   * @param options - standard error options; `cause` chains the provider failure.
   */
  constructor(message: string, code: DriveErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}
