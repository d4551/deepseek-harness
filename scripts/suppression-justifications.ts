/**
 * Scan shipped package source for suppressions that carry no reason.
 *
 * Two repository rules are stated in `AGENTS.md` and gated nowhere else: a
 * linter exception must be narrow and justified, and an empty `catch` must name
 * what it swallows. Both are checkable from the text around the suppression, so
 * an undocumented one is a defect a reader cannot evaluate.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { uniqueRepoFiles } from './repo-files.ts'

const ROOT = resolve(import.meta.dirname, '..')

/** A suppression whose reason a reader cannot find. */
export interface SuppressionViolation {
  /** Repository-relative file holding the suppression. */
  file: string
  /** 1-based line of the suppression itself. */
  line: number
  /** Which rule the suppression failed. */
  kind: 'lint-directive' | 'empty-catch'
  /** The suppressing text, trimmed for the failure message. */
  text: string
}

/** One scanned source file. */
export interface SuppressionSource {
  /** Repository-relative path. */
  file: string
  /** Complete file text. */
  content: string
}

const DIRECTIVE = /(?:oxlint|eslint)-disable(?:-next-line)?|biome-ignore/
const DIRECTIVE_HEAD = /^.*?(?:(?:oxlint|eslint)-disable(?:-next-line)?|biome-ignore)\s*[\w@/-]*/
const COMMENT_START = /^\s*(?:\/\/|\/\*|\*)/
/** `catch {` or `catch (e) {`, capturing everything up to the next brace of any kind. */
const CATCH_BLOCK = /\bcatch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g

/**
 * Whether a directive line, or the comment above its run, states a reason.
 *
 * A reason is written after the rule name, or once above a run of directives.
 * A `-next-line` run alternates directives with the single line each annotates,
 * so the walk upward steps over both.
 * @param lines - Every line of the file.
 * @param index - 0-based line of the directive.
 * @returns Whether a reader can find why the rule is suppressed here.
 */
function directiveIsJustified(lines: readonly string[], index: number): boolean {
  const tail = (lines[index] ?? '').replace(DIRECTIVE_HEAD, '').trim()
  // `--` opens the reason, which a block comment may continue on later lines.
  if (tail.startsWith('--') || tail.replace(/[:*/\s]+$/, '') !== '') return true
  let above = index - 1
  while (above >= 0 && (DIRECTIVE.test(lines[above] ?? '') || DIRECTIVE.test(lines[above - 1] ?? ''))) {
    above -= 1
  }
  return above >= 0 && COMMENT_START.test(lines[above] ?? '')
}

/**
 * Collect every suppression that states no reason.
 * @param sources - Files to scan, as path and complete text.
 * @returns One violation per undocumented suppression, in file then line order.
 */
export function scanSuppressions(sources: readonly SuppressionSource[]): SuppressionViolation[] {
  const violations: SuppressionViolation[] = []
  for (const { file, content } of sources) {
    const lines = content.split('\n')
    for (const [index, line] of lines.entries()) {
      if (!DIRECTIVE.test(line) || directiveIsJustified(lines, index)) continue
      violations.push({ file, line: index + 1, kind: 'lint-directive', text: line.trim() })
    }
    for (const match of content.matchAll(CATCH_BLOCK)) {
      const body = match[1] ?? ''
      // A body holding a statement handles the failure; only a body that drops
      // it silently has to say what it drops.
      if (body.split('\n').some(entry => entry.trim() !== '' && !COMMENT_START.test(entry))) continue
      if (body.includes('//') || body.includes('/*')) continue
      violations.push({
        file,
        line: content.slice(0, match.index).split('\n').length,
        kind: 'empty-catch',
        text: match[0].split('\n')[0]?.trim() ?? 'catch {',
      })
    }
  }
  return violations
}

/**
 * Load the shipped package source the suppression scan covers.
 * @param root - Repository root.
 * @returns Repository-relative path plus content for every scanned file.
 */
export function loadSuppressionCorpus(root: string = ROOT): SuppressionSource[] {
  return uniqueRepoFiles(
    root,
    ['packages/*/*/src/**/*.{ts,tsx}'],
    relativePath => relativePath.includes('node_modules/') || relativePath.includes('/lib/'),
  ).map(({ abs }) => ({
    file: abs.slice(root.length + 1).split('\\').join('/'),
    content: readFileSync(abs, 'utf8'),
  }))
}
