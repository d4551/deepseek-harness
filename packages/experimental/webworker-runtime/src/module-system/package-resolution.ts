/**
 * Package `exports` walking and file probing for the worker module system.
 *
 * These functions hold the pure resolution rules for Node package manifests
 * and the extension/directory probe order the worker applies to paths, kept
 * apart from the loader so its remaining file is only module state and
 * evaluation.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/module-system/package-resolution
 */
import type { MemoryVfs } from '../storage/memory.ts'
import { join } from './posix-path.ts'

/** Extensions the probe tries, in order, before treating a path as missing. */
const EXTENSIONS = ['.js', '.json', '.mjs', '.cjs'] as const

/** One value a package.json `exports` field may hold. */
export type ExportsField = string | null | readonly ExportsField[] | { readonly [key: string]: ExportsField }

/** The package.json fields the resolution rules read. */
export interface PackageManifest {
  readonly main?: string
  readonly exports?: ExportsField
}

/**
 * Walk one `exports` value against the condition set and requested subpath.
 * @param field - The `exports` value being walked.
 * @param subpath - Requested subpath, `.` for the package root.
 * @param packageName - Package name for diagnostics.
 * @param conditions - Conditions this runtime satisfies.
 * @returns The target the manifest names, if it exports the subpath.
 */
export function selectExport(
  field: ExportsField,
  subpath: string,
  packageName: string,
  conditions: ReadonlySet<string>,
): string | undefined {
  if (field === null) return undefined
  if (typeof field === 'string') return subpath === '.' ? field : undefined
  if (Array.isArray(field)) {
    for (const candidate of field as readonly ExportsField[]) {
      const picked = selectExport(candidate, subpath, packageName, conditions)
      if (picked !== undefined) return picked
    }
    return undefined
  }
  const entries = Object.entries(field as { [key: string]: ExportsField })
  const isSubpathMap = entries.some(([key]) => key === '.' || key.startsWith('./'))
  if (!isSubpathMap) {
    if (subpath !== '.') return undefined
    return selectCondition(field, packageName, subpath, conditions)
  }
  for (const [key, value] of entries) {
    if (key === subpath) {
      return typeof value === 'string' ? value : selectCondition(value, packageName, subpath, conditions)
    }
  }
  for (const [key, value] of entries) {
    const star = key.indexOf('*')
    if (star < 0) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    const captured = subpath.slice(prefix.length, subpath.length - suffix.length)
    const target = typeof value === 'string' ? value : selectCondition(value, packageName, subpath, conditions)
    if (target !== undefined) return target.replaceAll('*', captured)
  }
  return undefined
}

/**
 * Pick the first condition branch this runtime satisfies.
 * @param field - The condition object or nested value being walked.
 * @param packageName - Package name for diagnostics.
 * @param subpath - Requested subpath, `.` for the package root.
 * @param conditions - Conditions this runtime satisfies.
 * @returns The target the satisfied branch names, if any branch matches.
 */
function selectCondition(
  field: ExportsField,
  packageName: string,
  subpath: string,
  conditions: ReadonlySet<string>,
): string | undefined {
  if (field === null) return undefined
  if (typeof field === 'string') return field
  if (Array.isArray(field)) {
    for (const candidate of field as readonly ExportsField[]) {
      const picked = selectCondition(candidate, packageName, subpath, conditions)
      if (picked !== undefined) return picked
    }
    return undefined
  }
  for (const [key, value] of Object.entries(field as { [key: string]: ExportsField })) {
    if (!conditions.has(key)) continue
    const picked = selectCondition(value, packageName, subpath, conditions)
    if (picked !== undefined) return picked
  }
  return undefined
}

/**
 * Extension and directory probing for a concrete path.
 * @param vfs - Image filesystem paths resolve against.
 * @param manifestOf - Package.json reader for directories with manifests.
 * @param path - Candidate path before extensions apply.
 * @param specifier - Original specifier, for diagnostics.
 * @param fail - Loader failure reporter, which never returns.
 * @returns The first existing file path.
 */
export function probe(
  vfs: MemoryVfs,
  manifestOf: (directory: string) => PackageManifest,
  path: string,
  specifier: string,
  fail: (message: string) => never,
): string {
  const candidates: string[] = [path, ...EXTENSIONS.map(extension => path + extension)]
  for (const candidate of candidates) {
    if (vfs.existsSync(candidate) && vfs.statSync(candidate).isFile()) return candidate
  }
  if (vfs.existsSync(path) && vfs.statSync(path).isDirectory()) {
    if (vfs.existsSync(join(path, 'package.json'))) {
      const main = manifestOf(path).main
      if (main !== undefined) return probe(vfs, manifestOf, join(path, main), specifier, fail)
    }
    return probe(vfs, manifestOf, join(path, 'index'), specifier, fail)
  }
  return fail(`cannot resolve "${specifier}": no file at ${candidates.join(', ')}`)
}
