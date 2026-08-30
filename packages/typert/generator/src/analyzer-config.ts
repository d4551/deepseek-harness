/**
 * tsconfig parse for Typert package registration.
 */

import { dirname, resolve, sep } from 'node:path'
import { parseConfigFile, readJsoncObject } from './ts7-session.ts'
import { projectConfigPath } from './analyzer-exports.ts'

/** One parsed tsconfig, memoizable per workspace snapshot. */
export interface ParsedConfig {
  /** Absolute config path. */
  readonly path: string
  /** Source file names the config includes. */
  readonly fileNames: readonly string[]
  /** Project references as absolute tsconfig paths. */
  readonly projectReferences: readonly { readonly path: string }[]
}

function referencePaths(config: object, compilerPath: string): { path: string }[] {
  if (!Object.hasOwn(config, 'references')) return []
  const refs = Reflect.get(config, 'references')
  if (!Array.isArray(refs)) return []
  const result: { path: string }[] = []
  for (const ref of refs) {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref) || !Object.hasOwn(ref, 'path')) continue
    const path = Reflect.get(ref, 'path')
    if (typeof path !== 'string') continue
    result.push({ path: projectConfigPath(resolve(dirname(compilerPath), path)) })
  }
  return result
}

/**
 * Parse one tsconfig: TypeScript 7 fileNames plus JSONC project references.
 * @param path - absolute config path.
 * @returns memoizable parse result.
 */
export function parseConfig(path: string): ParsedConfig {
  const compilerPath = path.split(sep).join('/')
  const parsed = parseConfigFile(compilerPath)
  const config = readJsoncObject(compilerPath)
  return {
    path,
    fileNames: parsed.fileNames,
    projectReferences: config === undefined ? [] : referencePaths(config, compilerPath),
  }
}
