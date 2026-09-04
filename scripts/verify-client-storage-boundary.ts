/**
 * Client storage boundary gate: browser persistence (the local/session storage
 * pair) is a reviewed surface, not a grab-bag state channel. Every code
 * occurrence in client sources must sit in the allowlist below with its owning
 * reason; a new file, or a growing count inside an allowed file, fails the
 * gate until the entry is consciously widened. The pre-migration storage key
 * names are forbidden outright: the Host-backed settings document is the only
 * durable surface for those preferences.
 *
 * The scan ignores comments and string/template literals, so the vocabulary
 * below is detected only where it executes.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** One allowlisted file: its pinned occurrence count and why it exists. */
export interface StorageAllowlistEntry {
  /** Repository-relative file path with `/` separators. */
  path: string
  /** Exact number of code occurrences the review covers. */
  occurrences: number
  /** Why this file legitimately touches browser persistence. */
  reason: string
}

/**
 * The complete reviewed set of client files touching browser persistence.
 * A use outside these files fails the gate; add an entry only with a reason
 * a reviewer can check.
 */
export const STORAGE_ALLOWLIST: readonly StorageAllowlistEntry[] = [
  {
    path: 'packages/client/store/src/index.ts',
    occurrences: 5,
    reason: 'the opt-in snapshot-store persistence engine: generic, keyed by a caller-supplied store name, and the single reviewed persistence seam of the client tree',
  },
  {
    path: 'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx',
    occurrences: 2,
    reason: 'the dragged transcript width preference (px): one keyed read on mount and one write on gesture end',
  },
]

/** Storage key names from the pre-migration client that must never return. */
export const FORBIDDEN_STORAGE_KEYS: readonly string[] = [
  'dsh.theme',
  'dsh.locale',
  'dsh.conversation.busyEnter',
]

/** One detected browser-storage occurrence. */
export interface StorageUsage {
  /** Repository-relative file path with `/` separators. */
  path: string
  /** 1-based source line of the occurrence. */
  line: number
  /** The offending source line, trimmed. */
  text: string
}

/** One boundary violation: an unreviewed use, a forbidden key, or a drift. */
export interface BoundaryViolation {
  /** Repository-relative file path with `/` separators. */
  path: string
  /** 1-based line for in-code violations, 0 for corpus-level ones. */
  line: number
  /** What the reviewer must decide about. */
  detail: string
}

const STORAGE_TOKEN = /\b(?:localStorage|sessionStorage)\b/u
const FORBIDDEN_KEY_TOKEN = new RegExp(
  FORBIDDEN_STORAGE_KEYS.map(key => key.replaceAll('.', '\\.')).join('|'),
  'u',
)
const TOKEN_STARTS = new Set(['l', 's', 'd'])

interface SourceFinding extends StorageUsage {
  kind: 'storage' | 'forbidden-key'
}

/**
 * Find browser-storage occurrences and forbidden legacy keys in one source
 * file, skipping comments and string/template literal bodies so documentation
 * and fixtures never count.
 * @param path - repository-relative file path (`/` separators).
 * @param source - full file text.
 * @returns every executing occurrence with its line.
 */
export function findStorageUsages(path: string, source: string): SourceFinding[] {
  const usages: SourceFinding[] = []
  let line = 1
  let index = 0

  const endOfLine = (): number => {
    const newline = source.indexOf('\n', index)
    return newline === -1 ? source.length : newline
  }
  const skipLine = (): number => endOfLine()
  const skipBlock = (): number => {
    const end = source.indexOf('*/', index + 2)
    if (end === -1) {
      line += source.slice(index).split('\n').length - 1
      return source.length
    }
    line += source.slice(index, end).split('\n').length - 1
    return end + 2
  }
  const skipLiteral = (quote: string): number => {
    index += 1
    while (index < source.length) {
      const character = source[index] as string
      if (character === '\\') {
        index += 2
        continue
      }
      if (quote !== '`' && character === quote) return index + 1
      if (quote === '`' && character === '`') return index + 1
      if (quote === '`' && source.startsWith('${', index)) {
        index = skipInterpolation()
        continue
      }
      if (character === '\n') line += 1
      index += 1
    }
    return index
  }
  const skipInterpolation = (): number => {
    index += 2
    let depth = 1
    while (index < source.length) {
      const character = source[index] as string
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) return index + 1
      } else if (character === '\'' || character === '"') {
        index = skipLiteral(character)
        continue
      } else if (character === '`') {
        index = skipLiteral('`')
        continue
      } else if (character === '\n') line += 1
      index += 1
    }
    return index
  }

  const sweepToken = (): boolean => {
    if (!TOKEN_STARTS.has(source[index] as string)) return false
    const rest = source.slice(index, endOfLine())
    const storageHit = STORAGE_TOKEN.exec(rest)
    if (storageHit !== null && storageHit.index === 0) {
      usages.push({ path, line, text: rest.trim(), kind: 'storage' })
      index += storageHit[0].length
      return true
    }
    const keyHit = FORBIDDEN_KEY_TOKEN.exec(rest)
    if (keyHit !== null && keyHit.index === 0) {
      usages.push({ path, line, text: rest.trim(), kind: 'forbidden-key' })
      index += keyHit[0].length
      return true
    }
    return false
  }

  while (index < source.length) {
    const character = source[index] as string
    if (character === '\n') {
      line += 1
      index += 1
      continue
    }
    if (source.startsWith('//', index)) {
      index = skipLine()
      continue
    }
    if (source.startsWith('/*', index)) {
      index = skipBlock()
      continue
    }
    if (character === '\'' || character === '"' || character === '`') {
      index = skipLiteral(character)
      continue
    }
    if (sweepToken()) continue
    index += 1
  }
  return usages
}

/**
 * Apply the allowlist and the forbidden keys to a scanned corpus. Every
 * occurrence in an unallowlisted file violates; an allowlisted file whose
 * occurrence count drifted from its pinned number violates; any forbidden
 * legacy key violates; a corpus below the floor violates.
 * @param files - the scanned corpus: repository-relative paths and texts.
 * @param allowlist - the reviewed storage entries.
 * @param minimumFiles - smallest corpus the walk must yield.
 * @returns every violation, empty when the boundary holds.
 */
export function checkStorageBoundary(
  files: readonly { path: string; text: string }[],
  allowlist: readonly StorageAllowlistEntry[] = STORAGE_ALLOWLIST,
  minimumFiles = 50,
): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []
  if (files.length < minimumFiles) {
    violations.push({
      path: '(corpus)',
      line: 0,
      detail: `scanned ${String(files.length)} client source files, below the floor of ${String(minimumFiles)} — the walk is broken or narrowed`,
    })
    return violations
  }
  const allowlisted = new Map(allowlist.map(entry => [entry.path, entry]))
  for (const entry of allowlist) {
    if (!files.some(file => file.path === entry.path)) {
      violations.push({
        path: entry.path,
        line: 0,
        detail: 'allowlisted file left the corpus — update or retire the entry',
      })
    }
  }
  const counts = new Map<string, SourceFinding[]>()
  for (const file of files) {
    const usages = findStorageUsages(file.path, file.text)
    if (usages.length > 0) counts.set(file.path, usages)
  }
  for (const [path, usages] of counts) {
    const storageUsages = usages.filter(usage => usage.kind === 'storage')
    for (const usage of usages.filter(usage => usage.kind === 'forbidden-key')) {
      violations.push({ path: usage.path, line: usage.line, detail: `forbidden legacy storage key: ${usage.text}` })
    }
    const entry = allowlisted.get(path)
    if (entry === undefined) {
      for (const usage of storageUsages) {
        violations.push({ path: usage.path, line: usage.line, detail: `unreviewed browser storage use: ${usage.text}` })
      }
      continue
    }
    if (storageUsages.length !== entry.occurrences) {
      violations.push({
        path,
        line: 0,
        detail: `occurrence count drifted: allowlist pins ${String(entry.occurrences)}, found ${String(storageUsages.length)} — review the diff, then re-pin the entry`,
      })
    }
  }
  return violations
}

/** Repository-relative candidate source directories the gate must sweep. */
export function clientSourceDirectories(root: string = ROOT): string[] {
  const clientRoot = join(root, 'packages', 'client')
  const directories: string[] = []
  if (existsSync(clientRoot)) {
    for (const entry of readdirSync(clientRoot)) {
      const src = join(clientRoot, entry, 'src')
      if (existsSync(src) && statSync(src).isDirectory()) directories.push(src)
    }
  }
  const webSrc = join(root, 'apps', 'web', 'src')
  if (existsSync(webSrc)) directories.push(webSrc)
  return directories
}

/**
 * Walk one directory for `.ts`/`.tsx` files and return them as corpus entries
 * with repository-relative paths.
 * @param directory - absolute directory to walk.
 * @param root - repository root the relative paths are computed against.
 */
export function collectCorpus(directory: string, root: string = ROOT): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        files.push({
          path: full.slice(root.length + 1).split(sep).join('/'),
          text: readFileSync(full, 'utf8'),
        })
      }
    }
  }
  walk(directory)
  return files
}

/** Print one violation per line to stderr. */
export function reportBoundaryViolations(violations: readonly BoundaryViolation[]): void {
  for (const violation of violations) {
    const at = violation.line === 0 ? '' : `:${String(violation.line)}`
    process.stderr.write(`verify-client-storage-boundary: ${violation.path}${at} — ${violation.detail}\n`)
  }
}

/**
 * Verify the live client tree and exit nonzero on any boundary violation.
 * @returns exit code, 0 when the boundary holds.
 */
export function verifyClientStorageBoundary(root: string = ROOT): number {
  const directories = clientSourceDirectories(root)
  const files = directories.flatMap(directory => collectCorpus(directory, root))
  const violations = checkStorageBoundary(files)
  reportBoundaryViolations(violations)
  if (violations.length > 0) return 1
  process.stdout.write(`verify-client-storage-boundary: ${String(files.length)} client source files inside the reviewed storage boundary\n`)
  return 0
}

if (import.meta.main) {
  process.exit(verifyClientStorageBoundary())
}
