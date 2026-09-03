/**
 * The duplication gate's in-file override, banned.
 *
 * jscpd honours a start/end comment marker pair through its own built-in
 * handling, which no configuration switch turns off. Until today 562 such
 * markers stood in this repository's sources while `bun run duplication`
 * reported zero clones over 135 real ones. Removing them is not enough on its
 * own: nothing would stop the next one, and the tool offers no setting that
 * would refuse it. This check is that setting.
 *
 * A duplication exemption belongs in `.jscpd.json`'s `ignore` list, where it is
 * one reviewable path per entry, and not inside the file whose findings it
 * hides. The marker text is assembled here from parts rather than written out,
 * so this module and its tests are subject to the same ban as everything else.
 * @module scripts/no-duplication-overrides
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isEmittedOrVendored, uniqueRepoFiles } from './repo-files.ts'

const ROOT = resolve(import.meta.dirname, '..')

/** The banned marker, assembled so its literal text appears in no source. */
const MARKER = new RegExp(['jscpd', ':ignore-(?:start|end)'].join(''))

/** One source carrying a duplication override. */
export interface OverrideFinding {
  /** Repository-relative path. */
  file: string
  /** 1-indexed line the marker sits on. */
  line: number
  /** The offending line, trimmed. */
  text: string
}

/**
 * Every duplication-override marker in one source.
 *
 * A marker inside a string literal counts: that is a generator emitting one
 * into what it writes, which puts the same override in the generated file.
 * @param file - repository-relative path, reported with each finding.
 * @param source - the file's text.
 * @returns one finding per marked line, in line order.
 */
export function scanDuplicationOverrides(file: string, source: string): OverrideFinding[] {
  const findings: OverrideFinding[] = []
  source.split('\n').forEach((text, index) => {
    if (MARKER.test(text)) findings.push({ file, line: index + 1, text: text.trim() })
  })
  return findings
}

/**
 * Load every authored source the ban applies to.
 * @param root - repository root.
 * @returns relative path plus raw source.
 */
export function overrideCandidateFiles(root: string = ROOT): { file: string; source: string }[] {
  const patterns = ['packages/**/*.ts', 'packages/**/*.tsx', 'scripts/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx']
  return uniqueRepoFiles(root, patterns, isEmittedOrVendored).map(({ abs }) => ({
    file: abs.slice(root.length + 1).split('\\').join('/'),
    source: readFileSync(abs, 'utf8'),
  }))
}

/**
 * Scan the live tree for duplication overrides.
 * @param root - repository root.
 * @returns every finding; empty when no source carries a marker.
 */
export function auditDuplicationOverrides(root: string = ROOT): OverrideFinding[] {
  return overrideCandidateFiles(root).flatMap(({ file, source }) => scanDuplicationOverrides(file, source))
}
