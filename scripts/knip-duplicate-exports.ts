/**
 * Duplicate-export gate.
 *
 * `knip.json` excludes knip's `duplicates` issue type from `bun run knip`,
 * because this harness's plugin convention makes it fire on nearly every
 * package: a Cordis plugin module exports its Service class by name for typing
 * and as `default` for `ctx.plugin()`, which knip counts as two exports of one
 * binding. Excluding an issue type there and stopping would leave the class
 * unmeasured, so this gate runs the same knip detector and classifies what it
 * reports: the plugin convention and the named aliases below pass, and any
 * other module exporting one binding under two names fails.
 *
 * Run through the hygiene lane rather than the unit lane: it drives a full
 * knip analysis of the workspace, which costs about a minute.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** One module exporting a single binding under more than one name. */
export interface DuplicateExport {
  /** Repository-relative module path. */
  file: string
  /** Every exported name for that binding, in knip's order. */
  names: string[]
}

/**
 * Aliases that are the point of the module rather than an accident.
 *
 * A stub standing in for a third-party module must offer that module's own
 * export names; `ws` publishes its server class as both `WebSocketServer` and
 * the legacy `Server`, and code the worker loads unmodified reaches for either.
 * Every entry names one file, so a second module cannot inherit the exception.
 */
const NAMED_ALIAS_EXCEPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'packages/experimental/webworker-runtime/src/node/external_packages/ws.ts': ['Server', 'WebSocketServer'],
})

/**
 * Whether a duplicate is the Cordis plugin convention: one binding exported
 * under its own name and as the module default.
 * @param names - every exported name knip found for the binding.
 * @returns true for exactly two names, one of them `default`.
 */
export function isPluginDefaultConvention(names: readonly string[]): boolean {
  return names.length === 2 && names.includes('default')
}

/**
 * Whether a duplicate is a file-scoped alias exception declared above.
 * @param file - repository-relative module path.
 * @param names - every exported name knip found for the binding.
 * @returns true when this exact file declares this exact name set.
 */
export function isNamedAliasException(file: string, names: readonly string[]): boolean {
  const allowed = NAMED_ALIAS_EXCEPTIONS[file]
  if (allowed === undefined) return false
  return [...names].sort().join('|') === [...allowed].sort().join('|')
}

/**
 * Duplicate exports that are neither the plugin convention nor a declared alias.
 * @param duplicates - every duplicate knip reported.
 * @returns the ones a reader would have to explain, in input order.
 */
export function unexplainedDuplicateExports(duplicates: readonly DuplicateExport[]): DuplicateExport[] {
  return duplicates.filter(duplicate =>
    !isPluginDefaultConvention(duplicate.names) && !isNamedAliasException(duplicate.file, duplicate.names))
}

/**
 * Read knip's JSON report into duplicate rows.
 *
 * The reporter nests one array per duplicated binding inside each file's
 * `duplicates`, and each of those holds one entry per exported name. The
 * subprocess is a process boundary, so the document is validated rather than
 * trusted: a reporter that stopped emitting `duplicates` would otherwise read
 * as a clean tree.
 * @param report - stdout of `knip --include duplicates --reporter json`.
 * @returns one row per duplicated binding.
 */
export function parseKnipDuplicates(report: string): DuplicateExport[] {
  const document: unknown = JSON.parse(report)
  if (typeof document !== 'object' || document === null) throw new Error('knip report is not an object')
  const issues = (document as { issues?: unknown }).issues
  if (!Array.isArray(issues)) throw new Error('knip report has no issues array')
  const rows: DuplicateExport[] = []
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) throw new Error('knip issue is not an object')
    const { file, duplicates } = issue as { file?: unknown; duplicates?: unknown }
    if (duplicates === undefined) continue
    if (typeof file !== 'string') throw new Error('knip issue has no file')
    if (!Array.isArray(duplicates)) throw new Error(`knip duplicates for ${file} is not an array`)
    for (const group of duplicates) {
      if (!Array.isArray(group)) throw new Error(`knip duplicate group in ${file} is not an array`)
      rows.push({ file, names: group.map((entry) => {
        if (typeof entry !== 'object' || entry === null) throw new Error(`knip duplicate in ${file} is not an object`)
        const name = (entry as { name?: unknown }).name
        if (typeof name !== 'string') throw new Error(`knip duplicate in ${file} has no name`)
        return name
      }) })
    }
  }
  return rows
}

/**
 * Run knip's duplicate detector over the workspace.
 * @param root - repository root.
 * @returns one row per duplicated binding.
 */
export function liveDuplicateExports(root: string = ROOT): DuplicateExport[] {
  const report = execFileSync(
    'bunx',
    ['knip', '--include', 'duplicates', '--reporter', 'json', '--no-exit-code'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return parseKnipDuplicates(report)
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('\\').join('/'))) {
  const unexplained = unexplainedDuplicateExports(liveDuplicateExports())
  if (unexplained.length > 0) {
    for (const { file, names } of unexplained) {
      process.stderr.write(`${file}: one binding exported as ${names.join(' and ')}\n`)
    }
    process.stderr.write(
      `${unexplained.length} duplicate export(s) are neither the plugin default convention nor a declared alias.\n`,
    )
    process.exit(1)
  }
  process.stdout.write('duplicate exports: only the plugin default convention and declared aliases\n')
}
