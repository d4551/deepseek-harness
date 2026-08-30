/**
 * package.json export-target mapping for Typert package registration.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { TypertAnalysisError } from './analyzer-error.ts'
import { isWithin } from './analyzer-util.ts'

function optionalString(record: object, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined
  const value = Reflect.get(record, key)
  return typeof value === 'string' ? value : undefined
}

function exportTarget(value: object | string | number | boolean | null | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = exportTarget(candidate)
      if (target !== undefined) return target
    }
    return undefined
  }
  if (value === null || value === undefined || typeof value !== 'object') return undefined
  for (const key of ['types', 'import', 'default']) {
    const target = exportTarget(Reflect.get(value, key))
    if (target !== undefined) return target
  }
  for (const candidate of Object.values(value)) {
    const target = exportTarget(candidate)
    if (target !== undefined) return target
  }
  return undefined
}

/**
 * Map a package.json `exports` tree to `[subpath, target]` pairs.
 * @param manifest - parsed package.json object.
 * @returns sorted export subpaths with their filesystem targets.
 */
export function packageExportTargets(manifest: object): [string, string][] {
  const exportsField = Reflect.get(manifest, 'exports')
  if (typeof exportsField === 'string') return [['.', exportsField]]
  if (exportsField === null || typeof exportsField !== 'object') {
    const types = optionalString(manifest, 'types')
    return types === undefined ? [] : [['.', types]]
  }
  if (Array.isArray(exportsField)
    || !Object.keys(exportsField).some(key => key.startsWith('.'))) {
    const target = exportTarget(exportsField)
    return target === undefined ? [] : [['.', target]]
  }
  const result: [string, string][] = []
  for (const [subpath, value] of Object.entries(exportsField)) {
    if (!subpath.startsWith('.')) continue
    if (value === null || (typeof value !== 'object' && typeof value !== 'string')) continue
    const target = exportTarget(value)
    if (target !== undefined) result.push([subpath, target])
  }
  return result.sort(([left], [right]) => left.localeCompare(right))
}

export function hostExportSubpaths(manifest: object): string[] {
  return packageExportTargets(manifest)
    .map(([subpath]) => subpath)
    .filter(subpath => subpath !== './client'
      && !subpath.startsWith('./client/')
      && subpath !== './remote')
}

/**
 * Whether an export entry points at authored TypeScript source the analyzer
 * can open. Generated artifacts, metadata files, and bundle overlays
 * (`.json`/`.yml`/`.yaml`, wildcard patterns) have no source to walk.
 * @param subpath - export subpath such as `.` or `./typert`.
 * @param target - resolved export target path.
 * @returns true when the target maps to a TypeScript source file.
 */
export function isSourceExportTarget(subpath: string, target: string): boolean {
  return !target.includes('*')
    && subpath !== './package.json'
    && subpath !== './typert'
    && subpath !== './client/typert'
    && subpath !== './remote'
    && !target.endsWith('.json')
    && !target.endsWith('.yml')
    && !target.endsWith('.yaml')
}

export function clientExportSubpaths(manifest: object): string[] {
  return packageExportTargets(manifest)
    .map(([subpath]) => subpath)
    .filter(subpath => subpath === './client' || subpath.startsWith('./client/'))
}

export function isDualFacePackage(manifest: object): boolean {
  const dsh = Reflect.get(manifest, 'dsh')
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return false
  const client = Reflect.get(dsh, 'client')
  return client !== null
    && typeof client === 'object'
    && clientExportSubpaths(manifest).length > 0
}

export function sourcePathForExport(packageRoot: string, target: string): string {
  const normalized = target.replace(/^\.\//, '')
  if (normalized.startsWith('lib/types/')) {
    return resolve(packageRoot, 'src', normalized.slice('lib/types/'.length).replace(/\.d\.(?:mts|cts|ts)$/, '.ts'))
  }
  if (normalized.startsWith('lib/')) {
    return resolve(packageRoot, 'src', normalized.slice('lib/'.length).replace(/\.(?:mjs|cjs|js|d\.ts)$/, '.ts'))
  }
  return resolve(packageRoot, normalized)
}

/**
 * Validate one admitted package's entry surface. `exports` must be a
 * non-empty subpath-keyed map (Node-legal string or condition targets)
 * whose source targets exist inside the package; a package without
 * `exports` must declare `types`. Generated artifact and data entries
 * (`./typert`, `.json`, `.yml`, wildcards) carry no source and are exempt
 * from target checks.
 * @param manifest - parsed package.json object.
 * @param name - package name for diagnostics.
 * @param packageRoot - absolute package root.
 * @throws TypertAnalysisError when the entry surface is malformed.
 */
export function validatePackageEntrySurface(manifest: object, name: string, packageRoot: string): void {
  const exportsField = Reflect.get(manifest, 'exports')
  if (exportsField === undefined) {
    if (optionalString(manifest, 'types') === undefined) {
      throw new TypertAnalysisError(`${name} package.json must declare exports or types`)
    }
    return
  }
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)
    || Object.keys(exportsField).length === 0
    || !Object.keys(exportsField).every(key => key.startsWith('.'))) {
    throw new TypertAnalysisError(`${name} package.json exports must map subpaths to conditions`)
  }
  for (const [subpath, target] of packageExportTargets(manifest)) {
    if (!isSourceExportTarget(subpath, target)) continue
    const source = sourcePathForExport(packageRoot, target)
    if (!isWithin(source, packageRoot)) {
      throw new TypertAnalysisError(`${name} package.json exports must stay inside the package root`)
    }
    if (!existsSync(source)) {
      throw new TypertAnalysisError(`${name} package.json exports must point to existing files`)
    }
  }
}

export function projectConfigPath(path: string): string {
  if (path.endsWith('.json')) return path
  return resolve(path, 'tsconfig.json')
}
