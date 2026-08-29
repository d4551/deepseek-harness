/**
 * package.json export-target mapping for Typert package registration.
 */

import { resolve } from 'node:path'

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

export function projectConfigPath(path: string): string {
  if (path.endsWith('.json')) return path
  return resolve(path, 'tsconfig.json')
}
