/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module @deepseek-ai/dsh-settings/redact
 */

import type z from '@deepseek-ai/schemastery'

/**
 * Minimal structural view of a live schemastery node. Only the relations the
 * redactor walks are named; everything else on the instance is ignored.
 */
interface SchemaNode {
  type?: string
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array`/`transform` element schema. */
  inner?: SchemaNode
  /** `union`/`intersect`/`tuple` member schemas, in declaration order. */
  list?: SchemaNode[]
}

/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them, and the root of any subtree removed whole because its node
   * kind cannot be mapped onto the stored value.
   */
  secrets: RedactedSecret[]
}

/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether any `role('secret')` is declared at or beneath a node, following
 * every relation the structural view names. Cycles terminate on the seen set,
 * which recursive schemas reach through a shared node instance.
 */
function declaresSecret(node: SchemaNode | undefined, seen: WeakSet<SchemaNode>): boolean {
  if (node === undefined || seen.has(node)) return false
  seen.add(node)
  if (node.meta?.role === 'secret') return true
  if (declaresSecret(node.inner, seen)) return true
  for (const child of Object.values(node.dict ?? {})) {
    if (declaresSecret(child, seen)) return true
  }
  for (const child of node.list ?? []) {
    if (declaresSecret(child, seen)) return true
  }
  return false
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (key in properties) continue
          rebuilt[key] = entry
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const stripped = walk(child, source?.[key], [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      if (!isRecord(value)) return value
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets))
    }
    case 'tuple': {
      if (!Array.isArray(value)) return value
      const members = node.list ?? []
      return value.map((entry, index) => walk(members[index], entry, [...path, String(index)], secrets))
    }
    case 'union':
    case 'intersect': {
      // Members describe one position. Each pass removes the secrets its
      // member declares and carries the keys it does not describe; a member
      // the value does not match contributes its unset object slots.
      let carried = value
      for (const member of node.list ?? []) {
        carried = walk(member, carried, path, secrets)
        if (carried === undefined) return undefined
      }
      return carried
    }
    default: {
      // `transform` describes its input, not the stored result; `lazy`
      // resolves members only during validation; a `Schema.extend` type names
      // relations this view does not model. None maps onto the value, so a
      // secret declared beneath one removes the subtree.
      if (!declaresSecret(node, new WeakSet())) return value
      secrets.push({ path, set: value !== undefined })
      return undefined
    }
  }
}

/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker maps `object`, `dict`, `array`, `tuple`, `union`, and `intersect`
 * onto the value position by position. A `transform`, a `lazy`, or a type
 * registered through `Schema.extend` cannot be mapped that way, so a secret
 * declared beneath one removes that entire subtree and records its root. The
 * input is never mutated.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema, value, [], secrets)
  return { value: stripped, secrets }
}
