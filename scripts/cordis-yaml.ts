/**
 * Cordis YAML parsing and Loader-entry classification shared by repository checks.
 * @module scripts/cordis-yaml
 */

import { defineScalarTag, JSON_SCHEMA, load } from 'js-yaml'

/** A Loader `!!js` expression preserved as data instead of executed. */
export interface JsExpr {
  __jsExpr: string
}

const jsExprTag = defineScalarTag<JsExpr>('tag:yaml.org,2002:js', {
  identify: (value): value is JsExpr => typeof value === 'object' && value !== null && '__jsExpr' in value,
  resolve: (source: string): JsExpr => ({ __jsExpr: source }),
})
const schema = JSON_SCHEMA.withTags(jsExprTag)

/**
 * Parse a Cordis config while preserving Loader `!!js` expressions as data.
 * @param source - Cordis YAML source text.
 * @returns the parsed YAML value.
 */
export function loadCordisYaml(source: string): unknown {
  return load(source, { schema })
}

/**
 * Test whether a value is a preserved Loader `!!js` expression.
 * @param value - parsed YAML value.
 * @returns whether the value contains one preserved expression.
 */
export function isJsExpr(value: unknown): value is JsExpr {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).__jsExpr === 'string'
}

/**
 * Test whether a Loader entry owns nested entries in its `config` array.
 * @param value - parsed Loader entry.
 * @returns whether the entry is an explicit or package-named Cordis group.
 */
export function isCordisGroupEntry(value: unknown): value is Record<string, unknown> & { config: unknown[] } {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as Record<string, unknown>).config)
    && ((value as Record<string, unknown>).group === true
      || (value as Record<string, unknown>).name === '@deepseek-ai/cordis-plugin-group')
}
