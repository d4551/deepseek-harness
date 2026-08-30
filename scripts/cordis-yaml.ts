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
 * One value a Cordis YAML document can hold: scalars, preserved `!!js`
 * expressions, sequences, or mappings. Sparse sequence slots surface as
 * `undefined`.
 */
export type CordisValue =
  | string
  | number
  | boolean
  | null
  | JsExpr
  | Array<CordisValue | undefined>
  | { [key: string]: CordisValue | undefined }

/** One mapping node of a Cordis YAML document. */
export type CordisObject = { [key: string]: CordisValue | undefined }

/** One value a JSON/JSONC document can hold: scalars, arrays, or objects. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }

/**
 * Parse a Cordis config while preserving Loader `!!js` expressions as data.
 * @param source - Cordis YAML source text.
 * @returns the parsed YAML value.
 */
export function loadCordisYaml(source: string): CordisValue {
  return load(source, { schema }) as CordisValue
}

/**
 * Test whether a value is a preserved Loader `!!js` expression.
 * @param value - parsed YAML value.
 * @returns whether the value is one preserved expression node.
 */
export function isJsExpr(value: CordisValue): value is JsExpr {
  return typeof value === 'object'
    && value !== null
    && '__jsExpr' in value
    && typeof value.__jsExpr === 'string'
}

/**
 * Test whether a Loader entry owns nested entries in its `config` array.
 * @param value - parsed Loader entry.
 * @returns whether the entry is an explicit or package-named Cordis group.
 */
export function isCordisGroupEntry(value: CordisValue): value is { config: Array<CordisValue | undefined> } {
  return typeof value === 'object'
    && value !== null
    && 'config' in value
    && Array.isArray(value.config)
    && (('group' in value && value.group === true)
      || ('name' in value && value.name === '@deepseek-ai/cordis-plugin-group'))
}
