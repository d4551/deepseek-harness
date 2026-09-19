/**
 * Client mirror of the Host settings document: the one `settings.describe`
 * reader in the browser. Every settings consumer derives from this store —
 * per-namespace scopes through `SettingsScopeBinder.bind`, cross-namespace
 * surfaces through the binder's shared describe face — so startup cost and
 * freshness are properties of this class, not of how many features own a
 * preference. The Host stays the fact source: the mirror re-reads on the
 * invalidations its owning plugin subscribes to and folds write answers in
 * through {@link SettingsDescribeMirror.acceptView}.
 */

import type { ClientRemote, SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * The settings Remote methods browser configuration surfaces may reach: the
 * redacted read plus merge, replacement, and path-addressed writes.
 * Named once here so the consumers share one face instead of each re-deriving
 * it from the namespace.
 */
export type SettingsRemote = Pick<ClientRemote['settings'], 'describe' | 'update' | 'replace' | 'mutate'>

/** Wire face carrying the settings Remote namespace. */
export interface SettingsWireFace {
  /** The settings Remote namespace. */
  settings: SettingsRemote
}

type SettingsFace = SettingsWireFace
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

function thrownMessage(reason: Thrown): string {
  if (reason instanceof Error) return reason.message
  switch (typeof reason) {
    case 'string': return reason
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(reason)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (reason === null) return 'null'
      return Object.prototype.toString.call(reason)
  }
}

function isSettingsDescribeView(value: object): value is SettingsDescribeView {
  return 'namespaces' in value && 'writable' in value && 'hasDocument' in value
}

function describeOutcome(value: Thrown): { view: SettingsDescribeView } | { failure: string } {
  if (typeof value !== 'object' || value === null) return { failure: thrownMessage(value) }
  if (!('ok' in value)) return { failure: thrownMessage(value) }
  const ok = Reflect.get(value, 'ok')
  if (ok === true) {
    const view = 'value' in value ? Reflect.get(value, 'value') : undefined
    if (typeof view === 'object' && view !== null && isSettingsDescribeView(view)) {
      return { view }
    }
  }
  if (ok === false) {
    const error = 'error' in value ? Reflect.get(value, 'error') : undefined
    if (typeof error === 'object' && error !== null && 'message' in error) {
      const message = Reflect.get(error, 'message')
      if (typeof message === 'string') return { failure: message }
    }
  }
  return { failure: thrownMessage(value) }
}

/** The full `settings.describe` answer the mirror serves. */
export type SettingsDescribeView = SettingsDescribeValue

/** Mirror state every derived settings surface renders from. */
export interface SettingsMirrorSnapshot {
  /**
   * `unavailable` is the terminal non-loopback state; `ready` persists across
   * later failed refreshes (the held view keeps serving); `idle` means no
   * answer is held and no read is running, so `ensure` will start one.
   */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** The last good answer; undefined until the first success. */
  view: SettingsDescribeView | undefined
  /** The latest refresh failure message, cleared by the next success. */
  error: string | null
}

/**
 * The mirror as cross-namespace surfaces consume it: current answer,
 * subscription, first-use read, and the write-answer fold. `load` stays off
 * this face — invalidation refreshes belong to the mirror's owning plugin.
 */
export interface SettingsDescribeFace {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsMirrorSnapshot
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Resolve once an answer is held (or the mirror is terminally unavailable),
   * reading only from `idle`.
   * @returns settlement of the current or newly started read, if any.
   */
  ensure(): Promise<void>
  /**
   * Fold one write answer's namespace view into the held view without a wire
   * read, invalidating any older read still in flight.
   * @param view - the namespace view a settings write answered with.
   */
  acceptView(view: SettingsNamespaceView): void
}

/**
 * Serializes every Host `settings.describe` read behind one snapshot store.
 * Concurrent {@link load} calls fold into the in-flight read plus one rerun,
 * so an invalidation arriving mid-read is never lost and never duplicated.
 */
export class SettingsDescribeMirror implements SettingsDescribeFace {
  private readonly store: SnapshotStore<SettingsMirrorSnapshot>
  private inFlight: Promise<void> | undefined
  private rerun = false
  private generation = 0

  /**
   * @param api - settings wire face.
   * @param persistence - client-selected Host persistence; non-loopback pages may remain process-local.
   */
  constructor(
    private readonly api: SettingsFace,
    private readonly persistence: 'host' | 'memory' = 'host',
  ) {
    this.store = createSnapshotStore<SettingsMirrorSnapshot>({
      status: persistence === 'host' ? 'idle' : 'unavailable',
      view: undefined,
      error: null,
    })
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsMirrorSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Refresh from the Host. A call during an in-flight read marks one rerun
   * after it settles instead of racing a second wire read.
   * @returns settlement after this call's freshness is reflected.
   */
  load(): Promise<void> {
    if (this.persistence === 'memory') return Promise.resolve()
    if (this.inFlight !== undefined) {
      this.rerun = true
      return this.inFlight
    }
    // Own the slot before the loading publication can synchronously reenter load().
    const run = Promise.resolve().then(() => this.run())
    this.inFlight = run
    return run
  }

  /**
   * Resolve once an answer is held (or the mirror is terminally unavailable),
   * reading only from `idle`. The cheap idempotent entry for surfaces that
   * render on first use.
   * @returns settlement of the current or newly started read, if any.
   */
  ensure(): Promise<void> {
    if (this.persistence === 'memory') return Promise.resolve()
    if (this.inFlight !== undefined) return this.inFlight
    if (this.getSnapshot().status === 'idle') return this.load()
    return Promise.resolve()
  }

  /**
   * Fold one write answer's namespace view into the held view without a wire
   * read, and invalidate any read still in flight. With no held document, the
   * answer is not published as a partial document; an in-flight read reruns so
   * it cannot publish a document fetched before the write committed.
   * @param view - the namespace view a settings write answered with.
   */
  acceptView(view: SettingsNamespaceView): void {
    const before = this.store.getSnapshot()
    this.generation += 1
    if (this.inFlight !== undefined) this.rerun = true
    if (before.view === undefined) return
    const namespaces = before.view.namespaces.some(row => row.ns === view.ns)
      ? before.view.namespaces.map(row => row.ns === view.ns ? view : row)
      : [...before.view.namespaces, view]
    this.store.set({ ...before, view: { ...before.view, namespaces } })
  }

  /**
   * Convenience row lookup on the held view.
   * @param ns - namespace identity.
   * @returns the namespace view, or undefined while unanswered or unregistered.
   */
  namespace(ns: string): SettingsNamespaceView | undefined {
    return this.store.getSnapshot().view?.namespaces.find(row => row.ns === ns)
  }

  private async run(): Promise<void> {
    // Clear inFlight in the same synchronous segment that observes `rerun`
    // false (and on abrupt exit). A promise `.finally()` runs one microtask
    // later, and a `load()` landing in that gap would mark a rerun nobody
    // reads, losing the read.
    using _clearFlight = {
      [Symbol.dispose]: (): void => {
        this.inFlight = undefined
      },
    }
    do {
      const before = this.store.getSnapshot()
      if (before.status === 'idle') this.store.set({ ...before, status: 'loading' })
      // Cleared immediately before the wire read goes out: a load() marked
      // earlier (including one reentering from the loading publish above)
      // is covered by this very read, while one landing after needs the
      // rerun.
      this.rerun = false
      const generation = ++this.generation
      const describe = this.api.settings.describe
      let outcome: { view: SettingsDescribeView } | { failure: string }
      if (typeof describe !== 'function') {
        outcome = { failure: 'settings.describe is not a function' }
      } else {
        const response = await new Promise<Thrown>((resolve) => {
          resolve(describe.call(this.api.settings))
        }).then(
          (value: Thrown) => ({ kind: 'settled' as const, value }),
          (reason: Thrown) => ({ kind: 'failed' as const, reason }),
        )
        outcome = response.kind === 'failed'
          ? { failure: thrownMessage(response.reason) }
          : describeOutcome(response.value)
      }
      // A write answer invalidates a document read before that write committed.
      if (generation !== this.generation) continue
      if ('view' in outcome) {
        this.store.set({ status: 'ready', view: outcome.view, error: null })
      } else {
        const held = this.store.getSnapshot()
        // No answer yet: fall back to idle so `ensure` retries; with one, the
        // held view keeps serving and only the error field reports the miss.
        this.store.set({
          status: held.view === undefined ? 'idle' : 'ready',
          view: held.view,
          error: outcome.failure,
        })
      }
    } while (this.shouldRerun())
  }

  private shouldRerun(): boolean {
    return this.rerun
  }
}
