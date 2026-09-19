/**
 * The `Thrown` rejected-value union — a type-only utility (no runtime code, no
 * harness-package dependency) shared by every package that observes a Promise
 * rejection, a thrown exception, or an abort reason whose value the thrower
 * chose freely.
 *
 * JavaScript lets any value travel a reject arm: `throw 'boom'` and
 * `Promise.reject(42)` are both legal, so a `catch` parameter or a
 * `.catch` callback typed as `Error` silently narrows what the runtime can
 * actually deliver. `Thrown` names the full set — `object` for `Error`
 * instances and every structured value, the six primitives callers throw as
 * literals, and `null`/`undefined` for bare rejections — so handlers type the
 * value they receive instead of asserting the value they hoped for.
 *
 * Policy: a package that catches, records, forwards, or renders a rejection
 * annotates that boundary with `Thrown`; narrowing to `Error` or a domain
 * shape happens at the point the handler has evidence for it, never in the
 * shared vocabulary. This package owns ONLY the union — no predicate, no
 * formatter, no runtime code beyond the (erased) type — so the rejection
 * vocabulary stays dependency-free and a package can name what it caught
 * without depending on an unrelated capability package.
 *
 * @module @deepseek-ai/dsh-thrown
 */

/** Every value a throw or a Promise reject arm may deliver. */
export type Thrown = object | string | number | boolean | bigint | symbol | null | undefined
