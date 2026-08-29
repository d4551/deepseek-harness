/**
 * A dependency-light **retention** library: bounded model-facing output for
 * tools that must cap how much context they return. A caller feeds items or
 * text chunks into a bounded object, then gets the retained content plus exact
 * omission metadata ({@link RetainedItems} / {@link RetainedText}).
 *
 * The library owns ONLY the mechanical question "what did we keep, what did we
 * omit?". Tool-specific code still owns
 * business semantics: file grouping, line numbering, exit codes, provider error
 * states, per-line preview truncation, spill files, and the model-facing prose.
 * In particular {@link RetainedText.truncated}/{@link RetainedItems.truncated}
 * means "the retainer omitted otherwise-available content because of a budget" —
 * NOT "the upstream was incomplete". Permission failures, skipped binaries,
 * provider partial failures, and unreadable candidates stay in tool-domain
 * fields, never folded into `truncated`.
 *
 * This is deliberately a library, not a cordis service or plugin: it takes no
 * `ctx`, registers nothing, and emits no events. The two retainers are the only
 * stateful pieces and their state is per-instance (one accumulation), never
 * cross-call. Tool packages import it directly when they need bounded output.
 *
 * The two retainers differ in resource model, which is why they are two names
 * rather than one generic collector:
 * - {@link ItemRetainer} bounds ordered logical units (paths, grep matches,
 *   search sources). `head` retention only in v1.
 * - {@link TextRetainer} bounds byte-oriented text streams (bash stdout/stderr,
 *   web bodies). `head` / `tail` / `headTail`, preserving UTF-8 boundaries at
 *   {@link TextRetainer.finish}.
 *
 * @module @deepseek-ai/dsh-output-retention
 */

export { ItemRetainer } from './item-retainer.ts'
export { TextRetainer } from './text-retainer.ts'

/**
 * How much content the retainer omitted.
 *
 * `exact` is the normal retainer shape: every unit/byte was observed, so the
 * omitted count is precise. `unknown` is reserved for a caller that omits
 * without a count; the retainers themselves never return it.
 */
export type Omitted =
  | { kind: 'none' }
  | { kind: 'exact'; count: number }
  | { kind: 'unknown' }

/**
 * The caller receives this after each `push()`.
 */
export interface PushDecision {
  /** Was this whole unit / all of this chunk's bytes retained (nothing dropped)? */
  kept: boolean
  /** Cumulative: has the retainer omitted anything due to the budget yet? */
  truncated: boolean
}

/**
 * Final result for ordered logical units.
 *
 * `seen` means units OBSERVED by the retainer, not necessarily the total in the
 * upstream source. `kept` is `items.length`, surfaced explicitly so a notice
 * formatter need not re-count.
 */
export interface RetainedItems<T> {
  items: T[]
  truncated: boolean
  seen: number
  kept: number
  omitted: Omitted
}

/**
 * Final result for text streams.
 *
 * The returned `text` is safe to hand to a formatter: the retainer adds no
 * tool-specific headers, exit markers, XML tags, or recovery instructions, and
 * `omittedBytes` counts BYTES (not characters or lines) — text retention is
 * byte-oriented for process/body safety. UTF-8 boundaries at each cut are
 * preserved, so `text` never carries a replacement char introduced by the cut
 * itself.
 */
export interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: Omitted
}

/** Item retention strategy. Only `head` in v1; windows/grouped budgets wait for a second consumer. */
export type ItemRetentionStrategy = {
  /** Keep the first `maxItems` units. Use for `glob`, `grep`, and web sources. */
  kind: 'head'
  maxItems: number
}

/** Text retention strategy: keep a prefix, a suffix, or both, counted in bytes. */
export type TextRetentionStrategy =
  | {
    /** Keep the first `maxBytes` bytes. */
    kind: 'head'
    maxBytes: number
  }
  | {
    /** Keep the final `maxBytes` bytes. Requires reading to the end. */
    kind: 'tail'
    maxBytes: number
  }
  | {
    /** Keep a stable prefix and suffix, omitting the middle. Requires reading to the end. */
    kind: 'headTail'
    headBytes: number
    tailBytes: number
  }

/**
 * A neutral, tool-agnostic description of one retention outcome — the input to
 * {@link formatRetentionNotice}. It carries the mechanical facts (strategy,
 * unit, limit, kept count, {@link Omitted}); the tool supplies the recovery
 * words, because only the tool knows the recovery action ("narrow the pattern",
 * "fetch a more specific URL", "read the spill file").
 */
export interface RetentionNotice {
  /** Tool/scope label, e.g. `grep`, `web_fetch`, `bash stdout`. */
  scope: string
  strategy: 'head' | 'tail' | 'headTail'
  unit: 'items' | 'bytes' | 'chars' | 'lines'
  limit: number | { head: number; tail: number }
  kept: number
  omitted: Omitted
}

/**
 * Standardized, false-precision-safe wording for one {@link Omitted} value —
 * the "may standardize omission wording" half the library owns. `exact` prints
 * the count (`Omitted 3 items`); `unknown` prints NO count because the caller
 * did not provide one. `none` is the empty string.
 *
 * @param omitted The omission metadata from a retainer result.
 * @param unit The noun for the omitted quantity (`items`, `bytes`, `chars`, `lines`).
 * @returns A neutral clause (no trailing space), or `''` when nothing was omitted.
 */
export function describeOmitted(omitted: Omitted, unit: RetentionNotice['unit']): string {
  switch (omitted.kind) {
    case 'none':
      return ''
    case 'exact':
      return `Omitted ${omitted.count} ${unit}.`
    case 'unknown':
      return `More ${unit} were omitted.`
  }
}

/**
 * Turn a {@link RetentionNotice} into a one-line footer: the library-owned
 * standardized omission clause ({@link describeOmitted}) followed by the tool's
 * own recovery guidance. The library never owns recovery words — only the tool
 * knows the action ("narrow the pattern", "fetch a more specific URL", "read
 * the spill file") — so `recovery` supplies them and receives the full notice to
 * phrase from (`kept`, `limit`, `omitted`, …). Either half may be empty; the two
 * are joined with a single space.
 *
 * @param notice The neutral retention outcome.
 * @param recovery Tool-supplied guidance builder; receives the notice, returns a sentence (or `''`).
 * @returns The combined footer line.
 */
export function formatRetentionNotice(
  notice: RetentionNotice,
  recovery: (notice: RetentionNotice) => string,
): string {
  return [describeOmitted(notice.omitted, notice.unit), recovery(notice)]
    .filter(part => part.length > 0)
    .join(' ')
}
