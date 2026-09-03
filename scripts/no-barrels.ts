/**
 * Barrel detection over tracked TypeScript sources.
 *
 * A barrel is a module that forwards another module's symbols instead of
 * owning them. Two forms are rejected:
 *
 * - a **star re-export** (`export * from './x.ts'`), whose surface is whatever
 *   the target happens to export today, so no reader of the forwarding module
 *   can name what it publishes;
 * - a **pure barrel**, an internal module that declares nothing and exists only
 *   to forward, so a symbol's owner and its import path disagree.
 *
 * A module that declares its own API and also names a few forwarded symbols is
 * not a barrel. Neither is a module the package's own `exports` map publishes:
 * that module IS the boundary, and a package whose public surface spans several
 * files states it there rather than making every consumer guess which file owns
 * which name. What the rule removes is the internal forwarder — a module no
 * consumer can import directly, sitting between a caller and the declaration.
 *
 * Symbols that must cross a package boundary get a published subpath export —
 * the shape `packages/web/web-fetch-http/package.json` uses for `./policy`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isEmittedOrVendored, uniqueRepoFiles } from './repo-files.ts'

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

/** `export * from '…'`, `export type * from '…'`, and their `as ns` forms. */
const STAR_RE_EXPORT = /^[ \t]*export[ \t]+(?:type[ \t]+)?\*(?:[ \t]+as[ \t]+\w+)?[ \t]+from[ \t]+'([^']+)'/gm

/** `export { … } from '…'` and `export type { … } from '…'`, across lines. */
const NAMED_RE_EXPORT = /^[ \t]*export[ \t]+(?:type[ \t]+)?\{[\s\S]*?\}[ \t]*from[ \t]+'([^']+)'/gm

/** A declaration the module owns rather than forwards. */
const OWN_DECLARATION = new RegExp(
  '^[ \\t]*export[ \\t]+(?:default[ \\t]+|declare[ \\t]+)?(?:async[ \\t]+)?(?:abstract[ \\t]+)?'
  + '(?:(?:function|const|class|interface|enum|let|var)\\b|type[ \\t]+\\w)',
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
export function scanBarrels(file: string, source: string, publishedEntry = false): BarrelFinding[] {
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
  if (!publishedEntry && (forwarded.length > 0 || stars > 0) && !OWN_DECLARATION.test(code)) {
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
 * Whether a module is one of its own package's published `exports` targets.
 *
 * The manifest names emitted `lib/` paths, so a source module is matched by the
 * stem it emits under: `src/client.ts` publishes as `lib/client.js`, and the
 * Client build flattens `src/client/index.ts` to the same place.
 *
 * Matching only those emitted paths is what keeps the exemption narrow. Most
 * manifests also carry a `./src/*` subpath so a sibling can deep-import a
 * source module; that target is the literal `./src/*`, which equals no emitted
 * stem, so the wildcard grants no module an exemption it did not earn by being
 * a real entry.
 * @param file - repository-relative source path.
 * @param root - repository root.
 * @returns true when the package manifest publishes this module.
 */
export function isPublishedEntry(file: string, root: string): boolean {
  const parts = file.split('/src/')
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return false
  const manifest = resolve(root, parts[0], 'package.json')
  if (!existsSync(manifest)) return false
  const stem = parts[1].replace(/\.tsx?$/, '')
  const flattened = stem.replace(/\/index$/, '')
  const emitted = new Set([`./lib/${stem}.js`, `./lib/${flattened}.js`, `./lib/types/${stem}.js`])
  return exportTargets(manifest).some(target => emitted.has(target))
}

/**
 * Every file path a package manifest's `exports` map resolves to.
 *
 * The map is parsed rather than scanned: a substring search over the manifest
 * text matches a path that appears anywhere in it, including inside `files`,
 * `scripts`, or an unrelated field, which is the same defect this change
 * removed from `declaredRange` in `live-stack-floors.ts`.
 * @param manifest - absolute path to a package.json.
 * @returns every string leaf under `exports`, in no particular order.
 */
function exportTargets(manifest: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) return []
  const exports = (parsed as { exports?: unknown }).exports
  const targets: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { targets.push(node); return }
    if (typeof node !== 'object' || node === null) return
    for (const value of Object.values(node as Record<string, unknown>)) walk(value)
  }
  walk(exports)
  return targets
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
  return barrelCandidateFiles(root).flatMap(({ file, source }) => scanBarrels(file, source, isPublishedEntry(file, root)))
}
