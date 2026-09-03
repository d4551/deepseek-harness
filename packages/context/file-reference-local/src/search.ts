/**
 * Host-workspace discovery for `@file` completion. The index contains paths
 * only: selected values remain ordinary prompt text and file contents stay
 * behind the model-facing `read` tool.
 *
 * One index covers EVERY workspace root the session works in. Candidates from
 * the primary root keep their root-relative mention text, the form the
 * file-reference prompt tells the model to expect; candidates from an
 * additional root render as absolute paths, because a root-relative path would
 * collide with a same-named file in another root. Ranking always scores the
 * root-relative path, so a root prefix never decides a match.
 *
 * @module @deepseek-ai/dsh-file-reference-local/search
 */

import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference'

export { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

/** Default maximum file and directory candidates rendered for one query. */
export const DEFAULT_FILE_SEARCH_MAX_RESULTS = 20
/** Default maximum entries retained in one workspace search index. */
export const DEFAULT_FILE_SEARCH_MAX_ENTRIES = 50_000
/**
 * Directory basenames omitted from traversal unless the deployment overrides
 * them: version-control and dependency stores plus build-output names that no
 * ecosystem also uses for sources. Generated files carry the basenames of the
 * sources that produced them, so an unfiltered tree both spends the entry
 * budget twice and ranks `dist/x.js` beside `src/x.ts` for every query.
 *
 * `lib` is deliberately absent: Ruby gems and many npm packages keep their
 * sources there, and excluding it would make `@` miss those sources entirely
 * and silently. A workspace that builds into `lib` adds it through
 * `excludedDirectories`.
 */
export const DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
] as const

/** Resolved limits and exclusions for one workspace index. */
export interface FileSearchConfig {
  /** Maximum ranked candidates returned for one query. */
  maxResults: number
  /** Maximum indexed files and directories. */
  maxEntries: number
  /** Directory basenames never traversed or offered. */
  excludedDirectories: readonly string[]
}

/** One candidate paired with the paths that rank and order it. */
interface IndexedPath {
  /** Mention text as the user inserts it: root-relative for the primary root, absolute otherwise. */
  candidate: FileReferenceCandidate
  /** Root-relative path the query scores against, so a root prefix never ranks. */
  sortPath: string
  /** Position of the owning root in the configured order; breaks ties between equal `sortPath`s. */
  rootIndex: number
}

interface RankedPath {
  entry: IndexedPath
  score: number
}

/** One queued traversal directory and the root whose display form it belongs to. */
interface ScanDirectory {
  absolute: string
  /** Path relative to the owning root; empty for the root itself. */
  relative: string
  rootIndex: number
  /** Whether this entry is a workspace root, whose read failure fails the traversal. */
  isRoot: boolean
}

interface IndexGeneration {
  controller: AbortController
  promise: Promise<IndexedPath[]>
}

/** A completed traversal and the invalidation counter it observed at its start. */
interface SettledIndex {
  entries: IndexedPath[]
  startedAt: number
}

/**
 * Cancellable, reusable fuzzy index over one agent's workspace roots.
 * Directory-scoped queries list live state in every root; bare fuzzy queries
 * share one bounded traversal. Only the first query of a workspace waits for
 * that traversal — an invalidated index keeps answering while its replacement
 * builds behind the caret.
 */
export class WorkspaceFileSearch {
  private readonly excludedDirectories: ReadonlySet<string>
  private settled: SettledIndex | undefined
  private generation: IndexGeneration | undefined
  /** Monotonic invalidation counter; a settled index below it is stale. */
  private invalidations = 0
  private disposed = false

  constructor(
    private readonly roots: readonly string[],
    private readonly config: FileSearchConfig,
  ) {
    if (roots.length === 0) {
      throw new Error('file search requires at least one workspace root')
    }
    if (!Number.isSafeInteger(config.maxResults) || config.maxResults <= 0) {
      throw new Error('file search maxResults must be a positive safe integer')
    }
    if (!Number.isSafeInteger(config.maxEntries) || config.maxEntries <= 0) {
      throw new Error('file search maxEntries must be a positive safe integer')
    }
    if (config.excludedDirectories.some(name => name.length === 0 || name.includes('/') || name.includes('\\'))) {
      throw new Error('file search excludedDirectories entries must be non-empty directory basenames')
    }
    this.excludedDirectories = new Set(config.excludedDirectories)
  }

  /**
   * Return ranked path candidates for the current token.
   * @param rawQuery - path text following `@` or `@"`.
   * @param signal - cancels this caller's wait without killing an index shared by a newer query.
   * @returns at most `maxResults` deterministic candidates.
   */
  async list(rawQuery: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    signal.throwIfAborted()
    if (this.disposed) return []
    const query = rawQuery.replaceAll('\\', '/')
    const slash = query.lastIndexOf('/')
    if (query === '' || slash >= 0) {
      const directory = slash < 0 ? '' : query.slice(0, slash + 1)
      const fragment = slash < 0 ? '' : query.slice(slash + 1)
      return this.listDirectory(directory, fragment, signal)
    }
    const indexed = await this.indexFor(signal)
    return rankEntries(
      indexed.filter(entry => visibleForGlobalQuery(entry.sortPath, query)),
      query,
      this.config.maxResults,
    )
  }

  /**
   * Mark the index stale so a later bare query observes a fresh tree.
   *
   * The stale entries are kept and keep answering: a rebuild costs one
   * traversal of the whole workspace, and putting that in front of the caret
   * is what a caller invalidating on every tool result would otherwise pay.
   */
  invalidate(): void {
    this.invalidations += 1
  }

  /** Abort traversal and make later queries return no candidates. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation?.controller.abort(new Error('file search index disposed'))
    this.generation = undefined
    this.settled = undefined
  }

  /**
   * The entries a bare fuzzy query ranks. Only the first query of a workspace
   * waits for a traversal; afterwards a stale index answers immediately and
   * its replacement builds in the background.
   * @param signal - cancels this caller's wait without killing a shared traversal.
   * @returns indexed paths, at most one invalidation behind the tree.
   */
  private async indexFor(signal: AbortSignal): Promise<readonly IndexedPath[]> {
    const settled = this.settled
    if (settled === undefined) return waitForPromise(this.ensureIndex(), signal)
    if (settled.startedAt < this.invalidations) {
      void this.ensureIndex().catch(() => {
        // A background refresh failure is not this caller's error: the stale
        // entries still answer and `settled.startedAt` stays behind, so the
        // next bare query starts a fresh attempt.
      })
    }
    return settled.entries
  }

  private ensureIndex(): Promise<IndexedPath[]> {
    if (this.generation !== undefined) return this.generation.promise
    const controller = new AbortController()
    const startedAt = this.invalidations
    const generation = {
      controller,
      promise: Promise.resolve([] as IndexedPath[]),
    } satisfies IndexGeneration
    generation.promise = this.scanWorkspace(controller.signal).then(
      (entries) => {
        /* v8 ignore next -- disposal aborts this traversal, so it reaches the
         * rejection handler instead; the guard only covers a scan that finished
         * its last directory in the instant before the abort landed, and must
         * not hand a disposed index its entries back. */
        if (this.disposed) return entries
        this.generation = undefined
        this.settled = { entries, startedAt }
        return entries
      },
      (error: unknown) => {
        /* v8 ignore next -- dispose clears `generation` synchronously; this only protects an unexpected scan failure */
        if (this.generation === generation) this.generation = undefined
        throw error
      },
    )
    this.generation = generation
    return generation.promise
  }

  /**
   * Breadth-first across every root at once, so the entry budget reaches each
   * root's shallow paths before any root's deep ones. A path two roots both
   * reach is indexed once, under whichever root reached it first.
   * @param signal - cancels the traversal.
   * @returns the bounded index in traversal order.
   */
  private async scanWorkspace(signal: AbortSignal): Promise<IndexedPath[]> {
    const indexed: IndexedPath[] = []
    const seen = new Set<string>()
    const directories: ScanDirectory[] = this.roots.map((root, rootIndex) => ({
      absolute: root,
      relative: '',
      rootIndex,
      isRoot: true,
    }))
    for (let cursor = 0; cursor < directories.length && indexed.length < this.config.maxEntries; cursor += 1) {
      signal.throwIfAborted()
      const directory = directories[cursor]
      /* v8 ignore next 3 -- cursor is bounded by this exact queue's length. */
      if (directory === undefined) {
        throw new Error('file search selected a missing directory')
      }
      // A root is not a subtree: an unreadable branch costs its own
      // candidates, but an unreadable root means the traversal learned
      // nothing about it. Letting that settle would publish a partial index
      // over entries that are still good and leave no invalidation to retry from.
      const entries = directory.isRoot
        ? await readWorkspaceRoot(directory.absolute, signal)
        : await readDirectory(directory.absolute, signal)
      for (const entry of entries) {
        signal.throwIfAborted()
        const isDirectory = entry.isDirectory()
        if (!isDirectory && !entry.isFile()) continue
        if (isDirectory && this.excludedDirectories.has(entry.name)) continue
        const absolute = join(directory.absolute, entry.name)
        if (seen.has(absolute)) continue
        seen.add(absolute)
        const sortPath = directory.relative === '' ? entry.name : `${directory.relative}/${entry.name}`
        indexed.push({
          candidate: {
            path: this.mentionPath(directory.rootIndex, absolute, sortPath),
            kind: isDirectory ? 'directory' : 'file',
          },
          sortPath,
          rootIndex: directory.rootIndex,
        })
        if (isDirectory) {
          directories.push({ absolute, relative: sortPath, rootIndex: directory.rootIndex, isRoot: false })
        }
        if (indexed.length >= this.config.maxEntries) break
      }
    }
    return indexed
  }

  /**
   * List one directory level in every root that contains it. A relative query
   * names that directory inside each root; an absolute query resolves inside
   * exactly the root that contains it and yields nothing for the others.
   * @param displayDirectory - directory text the user typed, including its trailing slash.
   * @param fragment - text after the last slash, ranked against the level's entries.
   * @param signal - cancels the directory reads.
   * @returns at most `maxResults` deterministic candidates.
   */
  private async listDirectory(
    displayDirectory: string,
    fragment: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    if (displayDirectory.split('/').some(segment => this.excludedDirectories.has(segment))) return []
    const entries: IndexedPath[] = []
    const seen = new Set<string>()
    for (const [rootIndex, root] of this.roots.entries()) {
      const absolute = await resolveDisplayDirectory(root, displayDirectory, signal)
      if (absolute === undefined) continue
      for (const entry of await readDirectory(absolute, signal)) {
        if (entry.name.startsWith('.') && !fragment.startsWith('.')) continue
        const isDirectory = entry.isDirectory()
        if (!isDirectory && !entry.isFile()) continue
        if (isDirectory && this.excludedDirectories.has(entry.name)) continue
        const absolutePath = join(absolute, entry.name)
        if (seen.has(absolutePath)) continue
        seen.add(absolutePath)
        const sortPath = `${displayDirectory}${entry.name}`
        entries.push({
          candidate: {
            path: this.mentionPath(rootIndex, absolutePath, sortPath),
            kind: isDirectory ? 'directory' : 'file',
          },
          sortPath,
          rootIndex,
        })
      }
    }
    return rankEntries(entries, fragment, this.config.maxResults)
  }

  /**
   * The mention text one candidate is inserted as.
   * @param rootIndex - position of the owning root in the configured order.
   * @param absolute - the candidate's absolute host path.
   * @param rootRelative - the candidate's path within its own root.
   * @returns `rootRelative` for the primary root, the absolute path otherwise.
   */
  private mentionPath(rootIndex: number, absolute: string, rootRelative: string): string {
    return rootIndex === 0 ? rootRelative : absolute.replaceAll('\\', '/')
  }
}

async function resolveDisplayDirectory(
  root: string,
  displayDirectory: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const resolvedRoot = resolve(root)
  const absolute = resolve(resolvedRoot, displayDirectory === '' ? '.' : displayDirectory)
  const fromRoot = relative(resolvedRoot, absolute)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return undefined
  /* v8 ignore next -- only Windows can produce a cross-volume absolute relative path */
  if (isAbsolute(fromRoot)) return undefined
  let current = resolvedRoot
  for (const segment of fromRoot.split(sep).filter(Boolean)) {
    signal.throwIfAborted()
    current = join(current, segment)
    try {
      const status = await lstat(current)
      signal.throwIfAborted()
      if (status.isSymbolicLink() || !status.isDirectory()) return undefined
    } catch (_error: unknown) {
      signal.throwIfAborted()
      return undefined
    }
  }
  return absolute
}

async function readWorkspaceRoot(absolute: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const entries = await readdir(absolute, { withFileTypes: true })
  signal.throwIfAborted()
  return entries.sort((left, right) => compareText(left.name, right.name))
}

async function readDirectory(absolute: string, signal: AbortSignal) {
  signal.throwIfAborted()
  try {
    const entries = await readdir(absolute, { withFileTypes: true })
    signal.throwIfAborted()
    return entries.sort((left, right) => compareText(left.name, right.name))
  } catch (_error: unknown) {
    signal.throwIfAborted()
    // An unreadable/missing subtree contributes no candidates; other readable
    // branches remain useful and autocomplete is advisory.
    return []
  }
}

function visibleForGlobalQuery(path: string, query: string): boolean {
  if (query.startsWith('.') || query.includes('/.')) return true
  return !path.split('/').some(segment => segment.startsWith('.'))
}

function rankEntries(
  entries: readonly IndexedPath[],
  query: string,
  limit: number,
): FileReferenceCandidate[] {
  const ranked: RankedPath[] = []
  for (const entry of entries) {
    const score = scoreEntry(entry, query)
    if (score !== undefined) ranked.push({ entry, score })
  }
  // Root order is the last tie-break, so two roots holding the same path rank
  // primary-first instead of by whichever host enumeration finished sooner.
  ranked.sort((left, right) =>
    right.score - left.score
    || kindRank(left.entry.candidate.kind) - kindRank(right.entry.candidate.kind)
    || (query === '' ? 0 : left.entry.sortPath.length - right.entry.sortPath.length)
    || compareText(left.entry.sortPath, right.entry.sortPath)
    || left.entry.rootIndex - right.entry.rootIndex)
  return ranked.slice(0, limit).map(item => item.entry.candidate)
}

function scoreEntry(entry: IndexedPath, query: string): number | undefined {
  if (query === '') return 0
  const path = entry.sortPath.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const needle = query.toLowerCase()
  const directoryBonus = entry.candidate.kind === 'directory' ? 25 : 0
  if (name === needle) return 1_000 + directoryBonus
  if (name.startsWith(needle)) return 900 + directoryBonus
  if (name.includes(needle)) return 700 + directoryBonus
  if (path.includes(needle)) return 500 + directoryBonus
  const subsequence = subsequenceScore(path, needle)
  return subsequence === undefined ? undefined : 300 + subsequence + directoryBonus
}

function subsequenceScore(target: string, query: string): number | undefined {
  let targetIndex = 0
  let gap = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found < 0) return undefined
    gap += found - targetIndex
    targetIndex = found + 1
  }
  return Math.max(0, 100 - gap)
}

function kindRank(kind: FileReferenceCandidate['kind']): number {
  return kind === 'directory' ? 0 : 1
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  /* v8 ignore next -- `list()` checks this signal immediately before its synchronous call into this helper */
  if (signal.aborted) return Promise.reject(errorReason(signal.reason, 'file search aborted'))
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => { rejectPromise(errorReason(signal.reason, 'file search aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(errorReason(error, 'file search index failed'))
      },
    )
  })
}

function errorReason(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason })
}
