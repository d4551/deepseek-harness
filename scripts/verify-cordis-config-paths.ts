/**
 * Source-plane specifier resolution for {@link ./verify-cordis-config.ts}.
 * Matches `tsconfig.base.json` `paths` to a `.ts`/`.tsx` file without Strada
 * `resolveModuleName`.
 */

import { existsSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { readConfigFile, type JsonValue } from './ts7-session.ts'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

function existingSourceFile(candidate: string): string | undefined {
  if (!existsSync(candidate)) return undefined
  if (statSync(candidate).isFile()) {
    return SOURCE_EXTENSIONS.has(extname(candidate)) ? candidate : undefined
  }
  for (const name of ['index.ts', 'index.tsx']) {
    const nested = resolve(candidate, name)
    if (existsSync(nested) && statSync(nested).isFile()) return nested
  }
  return undefined
}

function stringList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  const targets: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') targets.push(entry)
  }
  return targets
}

function pathMap(config: JsonValue): Record<string, string[]> {
  if (typeof config !== 'object' || config === null || Array.isArray(config) || !Object.hasOwn(config, 'compilerOptions')) return {}
  const options = config.compilerOptions
  if (options === undefined || options === null || typeof options !== 'object' || Array.isArray(options) || !Object.hasOwn(options, 'paths')) return {}
  const paths = options.paths
  if (paths === undefined || paths === null || typeof paths !== 'object' || Array.isArray(paths)) return {}
  const mapped: Record<string, string[]> = {}
  for (const key of Object.keys(paths)) {
    const targets = stringList(paths[key])
    if (targets.length > 0) mapped[key] = targets
  }
  return mapped
}

/**
 * Resolve one specifier through `tsconfig.base.json` `paths` to a source file.
 * @param specifier - package or package-subpath specifier.
 * @param paths - compilerOptions.paths map.
 * @param root - repository root the path targets are relative to.
 * @returns absolute `.ts`/`.tsx` path, or undefined when no source mapping hits.
 */
export function resolveSpecifierThroughPaths(
  specifier: string,
  paths: Record<string, string[]>,
  root: string,
): string | undefined {
  const exact = paths[specifier]
  if (exact !== undefined) {
    for (const target of exact) {
      const hit = existingSourceFile(resolve(root, target))
      if (hit !== undefined) return hit
    }
  }
  let bestKey: string | undefined
  for (const key of Object.keys(paths)) {
    if (!key.endsWith('/*')) continue
    const prefix = key.slice(0, -1)
    if (!specifier.startsWith(prefix)) continue
    if (bestKey === undefined || key.length > bestKey.length) bestKey = key
  }
  if (bestKey === undefined) return undefined
  const prefix = bestKey.slice(0, -1)
  const rest = specifier.slice(prefix.length)
  for (const target of paths[bestKey] ?? []) {
    const mapped = target.endsWith('/*') ? target.slice(0, -1) + rest : target
    const hit = existingSourceFile(resolve(root, mapped))
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Load `compilerOptions.paths` from `tsconfig.base.json`.
 * @param root - repository root.
 * @returns `{ paths }` on success, or `{ error }` with a flattenable message.
 */
export function loadBasePaths(root: string): { paths: Record<string, string[]> } | { error: string } {
  const read = readConfigFile(resolve(root, 'tsconfig.base.json'))
  if (read.error !== undefined) return { error: read.error.messageText }
  const config = read.config
  if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
    return { error: 'tsconfig.base.json is not a JSON object' }
  }
  return { paths: pathMap(config) }
}
