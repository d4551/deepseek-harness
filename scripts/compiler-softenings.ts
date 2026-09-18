/**
 * Compiler and linter configuration must not silently weaken the program.
 * Injected misses fail; a clean tree is not the only passing case.
 */

import { parseConfigFileTextToJson, type JsonValue } from './ts7-session.ts'

/** One skipLibCheck softening found in a tsconfig document. */
export interface SkipLibCheckHit {
  /** Repository-relative path or injected fixture name. */
  file: string
}

function record(value: JsonValue | undefined): { [key: string]: JsonValue | undefined } | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value
}

/**
 * Report whether a tsconfig document enables skipLibCheck.
 * @param file - path used in the hit.
 * @param source - tsconfig JSONC text.
 * @returns a hit when skipLibCheck is true.
 */
export function skipLibCheckHits(file: string, source: string): SkipLibCheckHit[] {
  const parsed = parseConfigFileTextToJson(source)
  if (parsed.error !== undefined) throw new Error(`${file}: ${parsed.error.messageText}`)
  const compilerOptions = record(record(parsed.config)?.compilerOptions)
  if (compilerOptions === undefined) throw new Error(`${file}: compilerOptions is missing`)
  if (compilerOptions.skipLibCheck === true) return [{ file }]
  return []
}

/**
 * Oxlint default plugins plus this repository's accessibility plugin.
 * Setting `plugins` replaces the default set, so each name must stay listed.
 */
export const REQUIRED_OXLINT_PLUGINS = [
  'eslint',
  'typescript',
  'unicorn',
  'oxc',
  'jsx-a11y',
] as const

/**
 * Report whether an oxlint config empties plugins, drops a required plugin, or allows correctness.
 * @param file - path used in the hit.
 * @param source - oxlintrc JSONC text.
 * @returns hits for missing plugins and correctness:allow.
 */
export function oxlintSofteningHits(file: string, source: string): string[] {
  const parsed = parseConfigFileTextToJson(source)
  if (parsed.error !== undefined) throw new Error(`${file}: ${parsed.error.messageText}`)
  const config = record(parsed.config)
  if (config === undefined) throw new Error(`${file}: oxlint config is missing`)
  const hits: string[] = []
  const plugins = config.plugins
  if (!Array.isArray(plugins)) {
    hits.push(`${file}: plugins missing`)
  } else {
    if (plugins.length === 0) hits.push(`${file}: empty plugins`)
    const names = new Set(plugins.filter((plugin): plugin is string => typeof plugin === 'string'))
    for (const required of REQUIRED_OXLINT_PLUGINS) {
      if (!names.has(required)) hits.push(`${file}: missing plugin ${required}`)
    }
  }
  const categories = record(config.categories)
  if (categories?.correctness === 'allow') hits.push(`${file}: correctness allow`)
  return hits
}
