/**
 * Fail-capable scan of the CSS-Modules / `--dsw-*` styling SSOT: forbidden
 * stacks, token bypass, a second page shell, float layout, inline scripts,
 * missing theme focus/motion, and undersized interactive geometry.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { uniqueRepoFiles } from './repo-files.ts'

const ROOT = resolve(import.meta.dirname, '..')

/** One SSOT miss. */
export interface SsotFinding {
  /** Repository-relative path, or the fixture name. */
  file: string
  /** Detector that fired. */
  kind:
    | 'forbidden-stack'
    | 'token-bypass'
    | 'inline-script'
    | 'one-off-script'
    | 'shell-drift'
    | 'alignment'
    | 'focus-visible'
    | 'reduced-motion'
    | 'hit-target'
    | 'dangling-token'
  /** Why it fired. */
  detail: string
}

const THEME_STYLES_DIR = 'packages/client/ui-theme/src/styles/'
const APP_FRAME_CSS = 'packages/client/ui-layout/src/client/AppFrame.module.css'
const WEB_ENTRY = 'apps/web/src/main.ts'

const FORBIDDEN = /\b(daisyui|tailwindcss|htmx\.org|@tailwind|hx-(?:get|post|put|patch|delete|swap|trigger|boost|target))\b/
const COLOR_NAME = '(?:color|background(?:-color)?|border(?:-color)?|fill|stroke|outline-color)'
const COLOR_PROP = new RegExp(
  String.raw`(?:^|[;{\s])${COLOR_NAME}\s*:\s*(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\()`,
  'i',
)
const PAGE_SHELL = /(?:html|body|#root)\s*\{[^}]*display\s*:\s*grid/i
const FRAME_GRID = /\.frame\s*\{[^}]*display\s*:\s*grid/i
const FLOAT_LAYOUT = /float\s*:\s*(?:left|right)/i
const INLINE_SCRIPT = /<script(?![^>]*\btype\s*=\s*['"]module['"])[^>]*>/i
const INLINE_SCRIPT_BODY = /<script\b[^>]*>\s*[^<\s]/i
const ON_HANDLER = /\son(?:click|load|error|submit)\s*=/i
const INTERACTIVE = /(?:^|,)\s*(?:button|\[role=['"]button['"]\]|\.button)[^{]*\{([^}]*)\}/gi
const PX_SIZE = /(?:width|height|min-width|min-height)\s*:\s*(\d+)px/gi

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

function themeSheets(files: readonly { file: string; content: string }[]): string {
  return files
    .filter(({ file }) => file.replaceAll('\\', '/').startsWith(THEME_STYLES_DIR) && file.endsWith('.css'))
    .map(({ content }) => content)
    .join('\n')
}

/**
 * Scan a file set (live tree or injected fixtures) for SSOT misses.
 * @param files - path plus content.
 * @returns every finding.
 */
/** One style rule, with the reduced-motion state of the block holding it. */
interface CssRule {
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
function cssRules(css: string): CssRule[] {
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
function selectorParts(selector: string): string[] {
  return selector.split(',')
    // Whitespace around a combinator is not part of the selector's identity,
    // so a guard may be written tighter than the rule it answers.
    .map(part => part.trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' '))
    .filter(part => part !== '')
}

/** Whether a rule declares an animation that never ends on its own. */
function declaresInfiniteAnimation(body: string): boolean {
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
function stopsAnimation(body: string): boolean {
  return /animation\s*:\s*none\b/i.test(body)
    || /animation-play-state\s*:\s*paused\b/i.test(body)
    || /animation-iteration-count\s*:\s*[0-9]+\b/i.test(body)
    || shortensToNothing(body)
}

export function scanUiSsot(files: readonly { file: string; content: string }[]): SsotFinding[] {
  const findings: SsotFinding[] = []
  const sheets = themeSheets(files)
  if (!/:focus-visible\b/.test(sheets)) {
    findings.push({
      file: THEME_STYLES_DIR,
      kind: 'focus-visible',
      detail: 'ui-theme styles must define :focus-visible for interactive controls',
    })
  }
  if (!/prefers-reduced-motion/.test(sheets) || !/--ds-transition-duration:\s*0\.01ms/.test(sheets)) {
    findings.push({
      file: THEME_STYLES_DIR,
      kind: 'reduced-motion',
      detail: 'ui-theme must collapse --ds-transition-duration* under prefers-reduced-motion',
    })
  }

  const frame = files.find(({ file }) => file.replaceAll('\\', '/') === APP_FRAME_CSS)
  if (frame !== undefined && !FRAME_GRID.test(stripCssComments(frame.content))) {
    findings.push({
      file: APP_FRAME_CSS,
      kind: 'shell-drift',
      detail: 'AppFrame .frame must be display: grid',
    })
  }

  for (const { file, content } of files) {
    const path = file.replaceAll('\\', '/')
    const css = path.endsWith('.css') ? stripCssComments(content) : content

    if (FORBIDDEN.test(content)) {
      findings.push({ file: path, kind: 'forbidden-stack', detail: 'Tailwind, daisyUI, or htmx token in product UI' })
    }

    if (path.endsWith('.css') && !path.startsWith(THEME_STYLES_DIR) && COLOR_PROP.test(css)) {
      findings.push({ file: path, kind: 'token-bypass', detail: 'literal color on a painted property; use --dsw-* tokens' })
    }

    if (path.endsWith('.css') && !path.includes('ui-layout/') && PAGE_SHELL.test(css)) {
      findings.push({ file: path, kind: 'shell-drift', detail: 'second page shell (html/body/#root grid) outside ui-layout' })
    }

    if (path.endsWith('.css') && FLOAT_LAYOUT.test(css)) {
      findings.push({ file: path, kind: 'alignment', detail: 'float layout; use the AppFrame grid or flex in-module' })
    }

    if (/\.html?$/.test(path) && (INLINE_SCRIPT.test(content) || INLINE_SCRIPT_BODY.test(content) || ON_HANDLER.test(content))) {
      findings.push({ file: path, kind: 'inline-script', detail: 'inline or non-module script / HTML handler outside the Vite entry' })
    }

    if (path.startsWith('apps/web/src/') && path.endsWith('.js') && !path.endsWith('node-module-stub.js')) {
      findings.push({ file: path, kind: 'one-off-script', detail: `per-page helper outside ${WEB_ENTRY}` })
    }

    if (path.endsWith('.css')) {
      INTERACTIVE.lastIndex = 0
      let block: RegExpExecArray | null
      while ((block = INTERACTIVE.exec(css)) !== null) {
        const body = block[1] ?? ''
        const sizes: number[] = []
        PX_SIZE.lastIndex = 0
        let size: RegExpExecArray | null
        while ((size = PX_SIZE.exec(body)) !== null) {
          if (size[1] !== undefined) sizes.push(Number(size[1]))
        }
        if (sizes.length >= 2 && sizes.every(px => px < 24)) {
          findings.push({
            file: path,
            kind: 'hit-target',
            detail: `interactive geometry ${sizes.join('x')}px is below WCAG 2.5.8 24px`,
          })
        }
      }
    }
  }

  // An `animation` shorthand carries its own literal duration, so the theme's
  // reduced-motion collapse of `--ds-transition-duration*` never reaches it. A
  // loop that never ends is precisely the motion that setting asks to stop, so
  // every selector declaring one has to be answered by name: a guard somewhere
  // in the sheet says nothing about the selector actually moving, a guard the
  // animated rule overrides is dead in the cascade, and a media block that
  // merely opens and restyles a colour stops nothing.
  for (const { file: path, content } of files) {
    const rules = cssRules(stripCssComments(content))
    const guards = rules.filter(rule => rule.reduced && !rule.conditional && stopsAnimation(rule.body))
    for (const rule of rules) {
      if (rule.reduced || !declaresInfiniteAnimation(rule.body)) continue
      for (const part of selectorParts(rule.selector)) {
        const answered = guards.some(guard => guard.start > rule.start
          && selectorParts(guard.selector).some(target => target === part || target === '*'))
        if (answered) continue
        findings.push({
          file: path,
          kind: 'reduced-motion',
          detail: `\`${part}\` animates forever with no prefers-reduced-motion rule stopping it`,
        })
      }
    }
  }

  // Corpus-level, not per-file: a token is declared in the theme sheet and used
  // anywhere else. An undefined `var()` resolves to nothing, which drops the
  // whole declaration — error copy loses its colour, `1px solid var(...)` loses
  // its border — and no single-file rule can see that.
  const declared = new Set<string>()
  for (const { content } of files) {
    const text = stripCssComments(content)
    // A declaration is a CSS property, an object-literal key, or a quoted name
    // handed to `setProperty` — the `--dsh-*` band is published from TypeScript
    // as often as from a stylesheet, and both are equally a definition.
    for (const match of text.matchAll(/(--ds[wh]-[\w-]+)\s*:/g)) declared.add(match[1] ?? '')
    for (const match of text.matchAll(/['"](--ds[wh]-[\w-]+)['"]/g)) declared.add(match[1] ?? '')
  }
  for (const { file: path, content } of files) {
    const reported = new Set<string>()
    for (const match of stripCssComments(content).matchAll(/var\(\s*(--ds[wh]-[\w-]+)/g)) {
      const token = match[1] ?? ''
      if (declared.has(token) || reported.has(token)) continue
      reported.add(token)
      findings.push({
        file: path,
        kind: 'dangling-token',
        detail: `var(${token}) names no declared token; a fallback only hides the missing SSOT entry`,
      })
    }
  }

  return findings
}

/**
 * Load the live client/web UI files the SSOT scan covers.
 * @param root - repository root.
 * @returns path plus content.
 */
export function loadUiSsotCorpus(root: string = ROOT): { file: string; content: string }[] {
  return uniqueRepoFiles(root, [
    // `.ts` too: the `--dsh-*` band is published from TypeScript via
    // `setProperty` and inline style objects, so a corpus without it reads
    // every such token as undeclared.
    'packages/client/*/src/**/*.{css,ts,tsx,html}',
    'packages/client/*/src/styles/*.css',
    // Extension and prototype panels paint with the same design tokens, so they
    // answer to the same SSOT — a typo'd token is as broken there as anywhere.
    'packages/extensions/*/src/**/*.{css,tsx,html}',
    'packages/experimental/*/src/**/*.{css,tsx,html}',
    'apps/web/src/**/*.{ts,tsx,css,html,js}',
    'apps/web/index.html',
  ], relativePath => relativePath.includes('node_modules/') || relativePath.includes('/tests/') || relativePath.includes('/lib/'))
    .map(({ abs }) => {
      const file = abs.slice(root.length + 1).split('\\').join('/')
      return { file, content: readFileSync(abs, 'utf8') }
    })
}
