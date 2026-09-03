/**
 * What a dynamic package's Host half and browser half compute identically, in two parts.
 * The larger part is the value half of the client-safe wire vocabulary ./types.ts declares:
 * the failure record, and the Inspect Provider manifests with the JSON Schema constants they
 * carry. The smaller part is `ctxVerbForwarder`, the one guard rule that is dispatch rather
 * than policy; it lives here because the client bundle's allowlist names this single module,
 * and each guard still owns what it denies and how it explains a denial.
 *
 * Nothing here reads a platform — no Cordis service, no Node module, no browser API, and no
 * value import at all — so the emitted JavaScript carries no import and a client bundle
 * inlines it instead of requesting a module-table row.
 * @module @deepseek-ai/dsh-cordis-host-runner/wire-values
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { CordisErrorDetails, CordisInspectProviderManifest } from './types.ts'

/** Context verbs a guarded half may call in addition to the services its plugin declared. */
export const CTX_VERBS: ReadonlySet<string> = new Set([
  'effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce',
])

/** The subset of {@link CTX_VERBS} Cordis mixes in from the timer Service, reachable only once the plugin declares it. */
export const TIMER_VERBS: ReadonlySet<string> = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

/**
 * Build the lazy forwarder for one guarded Context verb. Resolution is deferred to the call
 * so a half never reads `ctx[verb]` for a verb its package never used, and a timer mixin is
 * refused before Cordis resolves it. The caller keeps both denial decisions: it supplies
 * `denyRead`, and it decides what a name that is not a verb means.
 * @param ctx - the half's real fiber Context, invoked as the receiver.
 * @param verb - property name read off the guard facade.
 * @param declared - service names the plugin declared in `inject`.
 * @param denyRead - the caller's refusal for a name this facade withholds.
 * @returns the forwarder, or undefined when the name is not a facade verb.
 */
export function ctxVerbForwarder(
  ctx: Context,
  verb: string,
  declared: ReadonlySet<string>,
  denyRead: (name: string) => never,
): ((...args: unknown[]) => unknown) | undefined {
  if (!CTX_VERBS.has(verb)) return undefined
  return (...args: unknown[]): unknown => {
    if (TIMER_VERBS.has(verb) && !declared.has('timer')) return denyRead('timer')
    const method = ctx[verb as keyof Context]
    return Reflect.apply(method as (...a: unknown[]) => unknown, ctx, args)
  }
}

/**
 * Preserve error fields for a failure record without fabricating a stack. Both halves run
 * package code whose throws cross a realm, so the fields are read by name rather than
 * through `instanceof Error`, which such a value fails.
 * @param error - original thrown value.
 * @returns its message and original string stack, when present.
 */
export function errorDetails(error: unknown): CordisErrorDetails {
  if (typeof error !== 'object' || error === null) return { message: String(error) }
  const message = 'message' in error && typeof error.message === 'string'
    ? error.message
    : Object.prototype.toString.call(error)
  const stack = 'stack' in error && typeof error.stack === 'string' ? error.stack : undefined
  return { message, ...stack === undefined ? {} : { stack } }
}

/** Input schema of an inspect query that accepts nothing. */
export const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const

/** Output schema of an inspect query whose JSON only the provider describes. */
export const ANY_OUTPUT = { description: 'JSON data owned by this inspect provider.' } as const

/**
 * Input schema of a progressive query: one optional exact name, absent for the directory.
 * @param field - property carrying the exact name.
 * @param description - what an exact value selects and what omitting it returns.
 * @returns the object schema declaring that single optional string property.
 */
export function exactInput(field: string, description: string): JsonValue {
  return { type: 'object', properties: { [field]: { type: 'string', description } }, additionalProperties: false }
}

/** Input schema of the Service directory-or-contract query. */
export const SERVICE_INPUT = exactInput('service', 'Exact Service key. Omit it for the compact Service and method-signature directory.')

/** Input schema of the Event directory-or-contract query. */
export const EVENT_INPUT = exactInput('event', 'Exact Event name. Omit it for the compact Event and listener-signature directory.')

/** Output schema of the Service directory-or-contract query. */
export const SERVICE_OUTPUT = {
  description: 'Compact Service directory, or one exact Service contract with only its referenced type declarations.',
} as const

/** Output schema of the Event directory-or-contract query. */
export const EVENT_OUTPUT = {
  description: 'Compact Event directory, or one exact Event contract with only its referenced type declarations.',
} as const

/**
 * Read one exact selector out of the JSON input a model sent.
 * @param input - query input as it arrived.
 * @param field - property naming the exact selection.
 * @returns the selector, or undefined when the property is absent or not a string.
 */
export function readExact(input: JsonValue | undefined, field: string): string | undefined {
  if (input === undefined || input === null || Array.isArray(input) || typeof input !== 'object') return undefined
  const value = input[field]
  return typeof value === 'string' ? value : undefined
}

/** One provider manifest paired with the local handler that answers its declared methods. */
export interface CordisInspectProvider {
  /** Provider identity and its explicit query directory. */
  manifest: CordisInspectProviderManifest
  /** Execute one declared read-only method; each platform registry passes its own query context, which this handler ignores. */
  query(method: string, input: JsonValue | undefined, context: unknown): Promise<JsonValue>
}

/**
 * Declare a provider whose directory holds exactly one method, described once for both the
 * provider row and the method row.
 * @param id - provider identity, unique within its platform.
 * @param description - capability text, reused as the method description.
 * @param method - the single declared method name.
 * @param query - handler for that method.
 * @param inputSchema - JSON Schema the method accepts.
 * @param outputSchema - JSON Schema the method returns.
 * @returns a registration either platform registry accepts.
 */
export function inspectProvider(
  id: string,
  description: string,
  method: string,
  query: (input: JsonValue | undefined) => JsonValue | Promise<JsonValue>,
  inputSchema: JsonValue = EMPTY_INPUT,
  outputSchema: JsonValue = ANY_OUTPUT,
): CordisInspectProvider {
  return {
    manifest: {
      id,
      description,
      methods: [{
        name: method,
        description,
        inputSchema,
        outputSchema,
      }],
    },
    async query(requested, input) {
      if (requested !== method) throw new Error(`unknown ${id} inspect method "${requested}"`)
      return await query(input)
    },
  }
}
