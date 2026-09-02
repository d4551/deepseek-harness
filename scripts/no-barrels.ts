/**
 * Barrel detection over tracked TypeScript sources.
 *
 * A barrel is a module that forwards another module's symbols instead of
 * owning them. Two forms are rejected:
 *
 * - a **star re-export** (`export * from './x.ts'`), whose surface is whatever
 *   the target happens to export today, so no reader of the forwarding module
 *   can name what it publishes;
 * - a **pure barrel**, a module that declares nothing and exists only to
 *   forward, so a symbol's owner and its import path disagree.
 *
 * A module that declares its own API and also names a few forwarded symbols is
 * not a barrel: it is the module the package's `exports` map points at. Symbols
 * that must cross a package boundary get a published subpath export instead —
 * the shape `packages/web/web-fetch-http/package.json` uses for `./policy`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { uniqueRepoFiles } from './repo-files.ts'

/** One rejected re-export. */
export interface BarrelFinding {
  /** Repository-relative path of the forwarding module. */
  file: string
  /** Which barrel form fired. */
  kind: 'star-re-export' | 'pure-barrel'
  /** What the module forwards, and why that is rejected. */
  detail: string
}

const ROOT = resolve(import.meta.dirname, '..')

/** `export * from '…'` and `export * as ns from '…'`. */
const STAR_RE_EXPORT = /^[ \t]*export[ \t]+\*(?:[ \t]+as[ \t]+\w+)?[ \t]+from[ \t]+'([^']+)'/gm

/** `export { … } from '…'` and `export type { … } from '…'`, across lines. */
const NAMED_RE_EXPORT = /^[ \t]*export[ \t]+(?:type[ \t]+)?\{[\s\S]*?\}[ \t]*from[ \t]+'([^']+)'/gm

/** A declaration the module owns rather than forwards. */
const OWN_DECLARATION = new RegExp(
  '^[ \\t]*export[ \\t]+(?:default[ \\t]+|declare[ \\t]+)?(?:async[ \\t]+)?(?:abstract[ \\t]+)?'
  + '(?:function|const|class|interface|type[ \\t]+\\w|enum|let|var)\\b',
  'm',
)

/**
 * Remove comments and string bodies so a re-export spelled inside either is not
 * mistaken for code. Quotes are replaced with empty ones to keep offsets sane.
 * @param source - raw TypeScript source.
 * @returns source with comment and string content blanked.
 */
function strippedSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
}

/**
 * Find every barrel in one module.
 * @param file - repository-relative path, used in findings.
 * @param source - raw TypeScript source.
 * @returns every finding, empty when the module forwards nothing it should not.
 */
export function scanBarrels(file: string, source: string): BarrelFinding[] {
  const code = strippedSource(source)
  const findings: BarrelFinding[] = []

  STAR_RE_EXPORT.lastIndex = 0
  let star: RegExpExecArray | null
  while ((star = STAR_RE_EXPORT.exec(code)) !== null) {
    findings.push({
      file,
      kind: 'star-re-export',
      detail: `forwards every symbol of ${star[1]}; import that module directly, or publish it as a subpath export`,
    })
  }

  NAMED_RE_EXPORT.lastIndex = 0
  const forwarded: string[] = []
  let named: RegExpExecArray | null
  while ((named = NAMED_RE_EXPORT.exec(code)) !== null) {
    const target = named[1]
    if (target !== undefined) forwarded.push(target)
  }
  const stars = findings.length
  if ((forwarded.length > 0 || stars > 0) && !OWN_DECLARATION.test(code)) {
    const targets = [...new Set(forwarded)].join(', ')
    findings.push({
      file,
      kind: 'pure-barrel',
      detail: `declares nothing and only forwards${targets === '' ? '' : ` ${targets}`}; delete it and import the owning module`,
    })
  }
  return findings
}

/**
 * Whether a matched path is emitted output or a pinned upstream copy.
 * @param relativePath - repository-relative path.
 * @returns true when the ban does not apply to it.
 */
function isEmittedOrVendored(relativePath: string): boolean {
  return relativePath.includes('/lib/') || relativePath.includes('/node_modules/') || relativePath.startsWith('vendor/')
}

/**
 * Load every tracked TypeScript source the ban applies to.
 *
 * Built output under `lib/` is emitted from these sources, and `vendor/` is a
 * pinned upstream copy this repository does not author.
 * @param root - repository root.
 * @returns relative path plus raw source.
 */
export function barrelCandidateFiles(root: string = ROOT): { file: string; source: string }[] {
  const patterns = ['packages/**/*.ts', 'packages/**/*.tsx', 'scripts/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx']
  return uniqueRepoFiles(root, patterns, isEmittedOrVendored).map(({ abs }) => {
    const file = abs.slice(root.length + 1).split('\\').join('/')
    return { file, source: readFileSync(abs, 'utf8') }
  })
}

/**
 * Scan the live tree.
 * @param root - repository root.
 * @returns every barrel finding across tracked sources.
 */
export function auditBarrels(root: string = ROOT): BarrelFinding[] {
  return barrelCandidateFiles(root).flatMap(({ file, source }) => scanBarrels(file, source))
}
