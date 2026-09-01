/**
 * CSS grammar core for the UI SSOT scan: comment/string skipping, rule
 * splitting with at-rule descent, and the reduced-motion guard predicates the
 * scanner credits.
 */

/**
 * Strip CSS comments so a mentioned hex in a caption is not a bypass.
 * @param css - stylesheet text.
 * @returns comment-free text.
 */
export function stripCssComments(css: string): string {
  let stripped = ''
  let index = 0
  while (index < css.length) {
    // charAt, not an index read: the loop bound proves the position, but
    // noUncheckedIndexedAccess widens an index read to include undefined.
    const character = css.charAt(index)
    if (character === '"' || character === "'") {
      const end = skipCssString(css, index)
      stripped += css.slice(index, end)
      index = end
      continue
    }
    if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2)
      stripped += ' '
      index = close < 0 ? css.length : close + 2
      continue
    }
    stripped += character
    index += 1
  }
  return stripped
}

/**
 * Index just past the string literal starting at `at`.
 *
 * `content: "/*"` is a value, not a comment opener, and `content: "{"` is not a
 * block. Both readings need the same rule about where a string ends, so they
 * share one.
 * @param css - stylesheet text.
 * @param at - index of the opening quote.
 * @returns index just past the closing quote, or the end of the text.
 */
function skipCssString(css: string, at: number): number {
  const quote = css[at]
  if (quote !== '"' && quote !== "'") return at
  let cursor = at + 1
  while (cursor < css.length) {
    if (css[cursor] === '\\') { cursor += 2; continue }
    if (css[cursor] === quote) return cursor + 1
    cursor += 1
  }
  return css.length
}

/** One style rule, with the reduced-motion state of the block holding it. */
export interface CssRule {
  /** Selector list as written, with runs of whitespace collapsed. */
  readonly selector: string
  /** Declarations the rule carries, including any nested block. */
  readonly body: string
  /** Offset the rule starts at, which orders it against the cascade. */
  readonly start: number
  /** Whether an enclosing `@media` asks for less motion. */
  readonly reduced: boolean
  /** Whether an enclosing at-rule may keep this rule from ever applying. */
  readonly conditional: boolean
}

/**
 * Split a stylesheet into its style rules.
 *
 * Brace matching rather than a pattern: a rule's body holds braces of its own,
 * and the media block a guard sits in has to be told apart from the rule it
 * guards. `@keyframes` is skipped whole — its `from`/`to` blocks are frames,
 * not selectors. At-rules are descended into so their inner rules are found;
 * style rules are taken as leaves, so a nested declaration is attributed to the
 * outer selector and still has to be answered by name.
 * @param css - stylesheet with comments already stripped.
 * @returns every style rule, in source order.
 */
export function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  // `content: "{"` is a brace the grammar does not count. Skipping quoted runs
  // keeps the depth honest; without it one such declaration shifts every rule
  // after it into the wrong block.
  // `url(...)` may hold an unquoted brace, which is part of the value and not a
  // block; skipping the whole function keeps the depth honest.
  const skipUnquotedUrl = (at: number, limit: number): number => {
    if (!/^url\(/i.test(css.slice(at, at + 4))) return at
    const close = css.indexOf(')', at + 4)
    return close < 0 ? limit : close + 1
  }
  const skipString = (at: number, limit: number): number => Math.min(skipCssString(css, at), limit)
  const walk = (from: number, to: number, reduced: boolean, conditional: boolean): void => {
    let index = from
    let preludeStart = from
    while (index < to) {
      const character = css.charAt(index)
      if (character === '"' || character === "'") {
        index = skipString(index, to)
        continue
      }
      if (character === 'u' || character === 'U') {
        const skipped = skipUnquotedUrl(index, to)
        if (skipped !== index) { index = skipped; continue }
      }
      if (character === '{') {
        const prelude = css.slice(preludeStart, index).trim().replace(/\s+/g, ' ')
        let depth = 1
        let end = index + 1
        while (end < to && depth > 0) {
          const inner = css[end]
          if (inner === '"' || inner === "'") { end = skipString(end, to); continue }
          if (inner === 'u' || inner === 'U') {
            const skipped = skipUnquotedUrl(end, to)
            if (skipped !== end) { end = skipped; continue }
          }
          if (inner === '{') depth += 1
          else if (inner === '}') depth -= 1
          end += 1
        }
        const bodyEnd = depth === 0 ? end - 1 : to
        if (prelude.startsWith('@')) {
          if (!/^@keyframes\b/i.test(prelude)) {
            // A guard the browser may never apply is not a guard. `@supports
            // not (...)` is the case that says so outright.
            const negated = /^@supports\b/i.test(prelude) && /\bnot\b/i.test(prelude)
            walk(index + 1, bodyEnd, reduced || asksForLessMotion(prelude), conditional || negated)
          }
        } else if (prelude !== '') {
          rules.push({
            selector: prelude,
            body: css.slice(index + 1, bodyEnd),
            start: preludeStart,
            reduced,
            conditional,
          })
        }
        index = end
        preludeStart = index
        continue
      }
      if (character === '}' || character === ';') preludeStart = index + 1
      index += 1
    }
  }
  walk(0, css.length, false, false)
  return rules
}

/**
 * Whether a media prelude asks for less motion.
 *
 * The feature name alone is not the question: `(prefers-reduced-motion:
 * no-preference)` matches readers who asked for motion, so a rule stopping an
 * animation there stops it for exactly the wrong people. Only `reduce` and the
 * boolean form count.
 * @param prelude - at-rule prelude as written.
 * @returns true when the block applies to a reader asking for less motion.
 */
function asksForLessMotion(prelude: string): boolean {
  // `not` inverts the whole query, so `not (prefers-reduced-motion: reduce)`
  // applies to readers who did not ask. Any negation disqualifies the prelude:
  // over-reporting a guard costs a finding to read, under-reporting hides
  // motion from the people who asked for none.
  if (/\bnot\b/i.test(prelude)) return false
  return /prefers-reduced-motion\s*:\s*reduce/i.test(prelude)
    || /\(\s*prefers-reduced-motion\s*\)/i.test(prelude)
}

/** Selectors a rule names, split from its comma-separated list. */
export function selectorParts(selector: string): string[] {
  return selector.split(',')
    // Whitespace around a combinator is not part of the selector's identity,
    // so a guard may be written tighter than the rule it answers.
    .map(part => part.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' '))
    .filter(part => part !== '')
}

/** Whether a rule declares an animation that never ends on its own. */
export function declaresInfiniteAnimation(body: string): boolean {
  return /animation(?:-name)?\s*:[^;}]*\binfinite\b/i.test(body)
    || /animation-iteration-count\s*:[^;}]*\binfinite\b/i.test(body)
}

/**
 * Whether a rule cuts an animation's duration to something nobody perceives.
 *
 * `animation-duration: 0.01ms` is the documented reduced-motion idiom: it ends
 * the animation while leaving `animationend` to fire, which `animation: none`
 * does not.
 * @param body - declarations the rule carries.
 * @returns true when a duration of at most a millisecond is declared.
 */
function shortensToNothing(body: string): boolean {
  const declared = /animation-duration\s*:\s*([0-9.]+)(m?s)\b/i.exec(body)
  if (declared === null) return false
  const value = Number(declared[1])
  return (declared[2]?.toLowerCase() === 's' ? value * 1000 : value) <= 1
}

/** Whether a rule stops an animation rather than merely restyling it. */
export function stopsAnimation(body: string): boolean {
  return /animation\s*:\s*none\b/i.test(body)
    || /animation-play-state\s*:\s*paused\b/i.test(body)
    || /animation-iteration-count\s*:\s*[0-9]+\b/i.test(body)
    || shortensToNothing(body)
}
