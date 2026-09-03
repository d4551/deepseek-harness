/**
 * One file-backed document's exclusive operation chain.
 *
 * A provider that owns a single document under the harness home needs the same
 * three things whatever the document holds: every write and every reload must
 * run one at a time, so a render can never start from text a concurrent reload
 * is replacing; an external edit must reach the process through a filesystem
 * watcher; and disposal must leave the document quiescent, with no queued
 * operation still able to publish. This module owns exactly that plumbing.
 *
 * What stays with the caller: reading, parsing, validating, rendering, and
 * publishing the document. The queue never opens the file for content — it
 * calls the caller's `reconcile` step and applies one policy to its failures:
 * an invariant violation propagates (a poisoned commit is not a reload
 * problem), and any other failure warns and keeps the caller's last good
 * snapshot, because a live hot reload must not take the process down.
 *
 * @module @deepseek-ai/dsh-document-queue
 */

import { watch as chokidarWatch } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Watcher poll interval ceiling, in milliseconds, while a write settles. */
const MAX_POLL_INTERVAL_MS = 10

/** Default watcher write-settle window in milliseconds. */
const DEFAULT_DEBOUNCE_MS = 100

/** Whether a document watches for external edits when config omits `watch`. */
const DEFAULT_WATCH = true

/** The deployment fields a document-backed provider's plugin config carries. */
export interface DocumentQueueConfig {
  /** Document path; defaults to the caller's basename under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}

/**
 * Loader field validators for {@link DocumentQueueConfig}, so every
 * document-backed provider validates these four keys identically. A provider
 * entry writes `z.object(DocumentQueueConfigFields)`; `gen-config-catalog`
 * follows that one named hop, so the plugin's accepted keys stay catalogued.
 */
export const DocumentQueueConfigFields = {
  path: z.string(),
  dshHome: z.string(),
  watch: z.boolean().default(DEFAULT_WATCH),
  debounceMs: z.number().min(0).default(DEFAULT_DEBOUNCE_MS),
}

/** A resolved document location and watch behavior; defaulting happens once, here. */
export interface DocumentSpec {
  /** Absolute path of the document. */
  readonly filename: string
  /** Whether external edits hot-publish through a filesystem watcher. */
  readonly watch: boolean
  /** Watcher write-settle window in milliseconds. */
  readonly debounceMs: number
}

/**
 * Resolve where one provider's document lives and how it watches: an explicit
 * `path` wins, otherwise the document sits at `<harness home>/<basename>`.
 * @param config - the raw plugin config.
 * @param basename - the document's file name under the harness home.
 * @returns the absolute location and watch behavior.
 */
export function resolveDocumentSpec(config: DocumentQueueConfig, basename: string): DocumentSpec {
  return {
    filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), basename)),
    watch: config.watch ?? DEFAULT_WATCH,
    debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
  }
}

/**
 * Whether a filesystem error means absence; every non-ENOENT failure must surface.
 * @param error - the rejected filesystem error.
 * @returns whether the error reports a missing path.
 */
export function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read one document's text, treating absence as a value rather than a failure.
 * Every other read failure surfaces: an unreadable document must not be
 * mistaken for an empty one.
 * @param filename - absolute path of the document.
 * @returns the document text, or `undefined` when the file does not exist.
 */
export async function readDocumentText(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, 'utf8')
  } catch (error) {
    if (!isENOENT(error)) throw error
    return undefined
  }
}

/** The logger severities a {@link DocumentQueue} reports through. */
export interface DocumentQueueLogger {
  /** Report a survivable reload or watcher failure. */
  warn(format: unknown, ...parameters: unknown[]): void
  /** Report a failure that escaped the caller's own reconcile policy. */
  error(format: unknown, ...parameters: unknown[]): void
}

/** Everything one {@link DocumentQueue} needs from the provider that owns the document. */
export interface DocumentQueueOptions {
  /** The owning plugin's diagnostic prefix, for example `settings-file`. */
  readonly label: string
  /** Absolute path of the document this queue serializes. */
  readonly filename: string
  /** Watcher write-settle window in milliseconds. */
  readonly debounceMs: number
  /** Diagnostic sink for watcher failures and survivable reload failures. */
  readonly logger: DocumentQueueLogger
  /**
   * Re-read the document and publish any difference. It runs inside the
   * queue, so it may read and replace the caller's snapshot without guarding
   * against a concurrent operation. It rejects when the document is
   * unreadable or invalid; {@link DocumentQueue.queueReload} then keeps the
   * caller's last good snapshot, while a caller that calls it inside
   * {@link DocumentQueue.enqueue} decides for itself.
   */
  readonly reconcile: () => Promise<void>
}

/**
 * The exclusive operation chain for one document, plus the watcher that feeds
 * reloads into it.
 *
 * Ordering is arrival order and the tail always settles, so one rejected
 * operation neither stalls the next nor leaks its rejection into it. After
 * {@link close} the queue refuses to start new work; operations already queued
 * still run, and `close` resolves only once they have settled, so a disposing
 * owner never leaves a write half-applied or a publication in flight.
 */
export class DocumentQueue {
  private readonly options: DocumentQueueOptions
  private operations: Promise<void> = Promise.resolve()
  private watcher: FSWatcher | undefined
  private closed = false

  /**
   * Create the chain for one document. Watching starts only at {@link watch}.
   * @param options - the document location, settle window, logger, and reconcile step.
   */
  constructor(options: DocumentQueueOptions) {
    this.options = options
  }

  /**
   * Whether disposal has begun. Opaque by construction: control flow cannot
   * narrow a method result across an await, so a caller that checks it after
   * one is reading current state.
   * @returns whether {@link close} has been called.
   */
  isClosed(): boolean {
    return this.closed
  }

  /**
   * Queue one exclusive document operation behind every earlier one.
   * @param operation - the work to run once the chain reaches it.
   * @returns whatever `operation` resolves to.
   * @throws whatever `operation` rejects with, unchanged.
   */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /**
   * Queue a reload. Only a failure escaping the caller's reconcile policy —
   * an invariant violation — can reject it; that rejection is reported and
   * absorbed so one poisoned commit cannot silently end hot reloading forever.
   */
  queueReload(): void {
    void this.enqueue(() => this.reload()).catch((error: unknown) => {
      this.options.logger.error('%s: reload commit failed at %s', this.options.label, this.options.filename)
      this.options.logger.error(error)
    })
  }

  /**
   * Watch the document and queue a reload for every change.
   *
   * The watcher also reconciles once when it becomes ready: the owner's
   * initial load raced the watcher's own setup, and a change written in that
   * window fires no event.
   * @returns a promise settling once the watcher is installed.
   */
  async watch(): Promise<void> {
    const watcher = chokidarWatch(await canonicalizeWatchPath(this.options.filename), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: this.options.debounceMs,
        pollInterval: Math.max(1, Math.min(this.options.debounceMs, MAX_POLL_INTERVAL_MS)),
      },
    })
    this.watcher = watcher
    watcher.on('all', () => {
      if (this.closed) return
      this.queueReload()
    })
    watcher.on('ready', () => {
      if (this.closed) return
      this.queueReload()
    })
    watcher.on('error', (error) => {
      this.options.logger.warn('%s: watcher error on %s', this.options.label, this.options.filename)
      this.options.logger.warn(error)
    })
  }

  /**
   * Quiesce the document: refuse new work, stop the watcher, and wait out
   * every queued or in-flight operation, so nothing publishes after disposal.
   * Repeated calls are safe and wait for the same tail.
   * @returns a promise settling once the chain is idle.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.watcher?.close()
    await this.operations
  }

  /**
   * Re-read after a watcher event. An unreadable or invalid document keeps the
   * owner's last good snapshot and warns — a live hot reload must never take
   * the process down. An invariant violation escaping the owner's publication
   * is not a reload failure and propagates to {@link queueReload}.
   */
  private async reload(): Promise<void> {
    if (this.closed) return
    try {
      await this.options.reconcile()
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') throw error
      this.options.logger.warn(
        '%s: reload failed at %s; keeping the last good document',
        this.options.label,
        this.options.filename,
      )
      this.options.logger.warn(error)
    }
  }
}
