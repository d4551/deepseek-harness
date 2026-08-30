/**
 * Path and collection helpers for the Typert analyzer.
 */

import { existsSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { CrossFaceLink } from './model.ts'

const realPathCache = new Map<string, string>()

/**
 * Canonical absolute path. Existing paths are memoized for the process.
 * @param path - file or directory path.
 * @returns real path when the target exists, otherwise the resolved absolute path.
 */
export function realPath(path: string): string {
  const absolute = resolve(path)
  const cached = realPathCache.get(absolute)
  if (cached !== undefined) return cached
  if (!existsSync(absolute)) return absolute
  const resolved = realpathSync(absolute)
  realPathCache.set(absolute, resolved)
  return resolved
}

/**
 * Whether a path is a directory or its descendant, comparing real paths.
 * @param path - candidate path.
 * @param root - containing directory.
 * @returns true when `path` is `root` or lies under it.
 */
export function isWithin(path: string, root: string): boolean {
  const absolute = realPath(path)
  const parent = realPath(root)
  return absolute === parent || absolute.startsWith(parent + sep)
}

/**
 * Normalize a path to forward slashes so ids compare the same on every platform.
 * @param value - path with either separator.
 * @returns the path with `\\` replaced by `/`.
 */
export function slash(value: string): string {
  return value.replaceAll('\\', '/')
}

/**
 * Keep the first value per key, in input order.
 * @param values - values to filter.
 * @param key - identity of one value.
 * @returns the deduplicated values.
 */
export function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>()
  for (const value of values) if (!result.has(key(value))) result.set(key(value), value)
  return [...result.values()]
}

/**
 * Total order over cross-face links, so generated artifacts are stable.
 * @param left - first link.
 * @param right - second link.
 * @returns negative, zero, or positive, comparing every field in declaration order.
 */
export function compareCrossFaceLinks(left: CrossFaceLink, right: CrossFaceLink): number {
  return left.fromFace.localeCompare(right.fromFace)
    || left.fromPackage.localeCompare(right.fromPackage)
    || left.toFace.localeCompare(right.toFace)
    || left.toPackage.localeCompare(right.toPackage)
    || left.subpath.localeCompare(right.subpath)
    || left.name.localeCompare(right.name)
}

/**
 * Whether a file is one of the compiler's own `lib.*.d.ts` declarations.
 * @param file - source-file path.
 * @returns true for a bundled standard-library file.
 */
export function isStandardLibraryFile(file: string): boolean {
  const base = file.replaceAll('\\', '/')
  // TS6 resolves lib files as .../node_modules/typescript/lib/lib.*.d.ts; TS7
  // ships them per-platform as .../node_modules/@typescript/typescript-<plat>/lib/.
  return /\/node_modules\/(?:typescript|@typescript\/typescript[^/]*)\/lib\/lib\.[^/]+\.d\.ts$/.test(base)
}

/**
 * The specifier an importer writes for one package export subpath.
 * @param packageName - owning package.
 * @param subpath - export subpath, `.` for the root entry.
 * @returns the package name, with the subpath appended for a non-root entry.
 */
export function packageExportSpecifier(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`
}
