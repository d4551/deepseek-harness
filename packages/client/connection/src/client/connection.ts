/** Stable Host facts delivered by one established Remote event generation. */
export interface ConnectionHostInfo {
  /** Host account home used only to abbreviate displayed filesystem paths. */
  readonly home: string
}

/** One successfully established Host generation. */
export interface ConnectionGeneration {
  /** Monotone generation number within this Client runtime. */
  readonly id: number
  /** Host facts carried by this generation's opening frame. */
  readonly host: ConnectionHostInfo
}

/** Reconnect/backoff tunables (deployment-varying — no hardcoded tunables; these become the
 *  future `ctx.connection` plugin's Config). All fields optional; defaults below. */
export interface ConnectionConfig {
  /** First-retry backoff cap in ms (jittered: actual delay is cap/2..cap). */
  backoffBaseMs?: number
  /** Exponential growth factor per consecutive failed attempt. */
  backoffFactor?: number
  /** Upper bound for the backoff cap in ms. */
  backoffMaxMs?: number
  /** Maximum wait for the registered generation source's ready signal. */
  generationReadyTimeoutMs?: number
}

const CONNECTION_DEFAULTS: Required<ConnectionConfig> = {
  backoffBaseMs: 500,
  backoffFactor: 2,
  backoffMaxMs: 10_000,
  generationReadyTimeoutMs: 3_000,
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** Coarse connection state for the UI: 'connected' after each generation's handshake,
 *  'reconnecting' the moment the generation fails (covers the whole backoff+retry span). */
export type ConnectionState = 'connected' | 'reconnecting'

/** Connection-generation callbacks owned by API Gateway. */
export interface ConnectionSinks {
  /** After the generation source reports ready, first connect included. */
  onConnected?: (host: ConnectionHostInfo) => void
  /** Coarse state transitions (deduplicated: fires only on change). The initial pre-connect
   *  span reports nothing — the UI treats "no state yet" as connecting, not as an outage. */
  onStateChange?: (state: ConnectionState) => void
}

/**
 * One long-lived source defining a Connection generation. The source must
 * attach its incremental listeners before calling `ready`, then remain pending
 * until the generation is lost or `signal` aborts.
 * @param signal - cancellation for the current generation.
 * @param ready - one-shot report that incremental delivery is attached.
 * @returns a promise settling only when this generation ends or fails.
 */
export type ConnectionGenerationSource = (
  signal: AbortSignal,
  ready: (host: ConnectionHostInfo) => void,
) => Promise<void>

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/** Handshake settlement before sinks run. */
type Handshake =
  | { readonly kind: 'ready'; readonly host: ConnectionHostInfo }
  | { readonly kind: 'unavailable'; readonly reason: Thrown }

function handshakeReady(host: ConnectionHostInfo): Handshake {
  return { kind: 'ready', host }
}

function handshakeUnavailable(reason: Thrown): Handshake {
  return { kind: 'unavailable', reason }
}

/**
 * Opens the registered generation source, reconnecting with exponential backoff on loss.
 * State (generation/attempt) is instance-private, never in the store.
 * A sink throw aborts the current generation and fails the loop.
 */
export class ConnectionController {
  private generation = 0
  private attempt = 0
  private current: AbortController | null = null
  private run: AbortController | null = null
  private completion: Promise<void> = Promise.resolve()
  private lastState: ConnectionState | null = null
  private readonly config: Required<ConnectionConfig>

  constructor(
    private readonly source: ConnectionGenerationSource,
    private readonly sinks: ConnectionSinks = {},
    config: ConnectionConfig = {},
  ) {
    this.config = { ...CONNECTION_DEFAULTS, ...config }
  }

  /**
   * Idempotent: begin the connect/pump/reconnect loop.
   * @returns settlement of this controller's loop; a sink throw rejects it.
   */
  start(): Promise<void> {
    if (this.run !== null) return this.completion
    this.run = new AbortController()
    this.completion = Promise.all([
      this.completion.then(
        () => ({ kind: 'fulfilled' as const }),
        (reason: Thrown) => ({ kind: 'rejected' as const, reason }),
      ),
      this.loop(this.run.signal).then(
        () => ({ kind: 'fulfilled' as const }),
        (reason: Thrown) => ({ kind: 'rejected' as const, reason }),
      ),
    ]).then((outcomes) => {
      const failures = outcomes.filter((outcome): outcome is { readonly kind: 'rejected'; readonly reason: Thrown } =>
        outcome.kind === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(failures.map(outcome => outcome.reason), 'connection loop failed')
      }
    })
    return this.completion
  }

  /** Abort immediately, then await every started generation, including retiring sources. */
  stop(): Promise<void> {
    this.run?.abort()
    this.run = null
    this.current?.abort()
    this.current = null
    return this.completion
  }

  private backoffDelay(attempt: number): number {
    const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config
    const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1))
    return cap / 2 + Math.random() * (cap / 2)
  }

  /** Re-read both mutable liveness guards after a potentially reentrant sink. */
  private isGenerationActive(controller: AbortController): boolean {
    return this.current === controller && !controller.signal.aborted
  }

  private isRunActive(run: AbortSignal): boolean {
    return this.run?.signal === run && !run.aborted
  }

  private async loop(run: AbortSignal): Promise<void> {
    const sources = new Set<Promise<void>>()
    await using _waitSources = {
      async [Symbol.asyncDispose](): Promise<void> {
        const outcomes = await Promise.all([...sources].map(source => source.then(
          () => ({ kind: 'fulfilled' as const }),
          (reason: Thrown) => ({ kind: 'rejected' as const, reason }),
        )))
        const failures = outcomes.filter((outcome): outcome is { readonly kind: 'rejected'; readonly reason: Thrown } =>
          outcome.kind === 'rejected')
        if (failures.length > 0) {
          throw new AggregateError(failures.map(outcome => outcome.reason), 'connection generation sources failed')
        }
      },
    }
    await this.pump(run, sources)
  }

  private async pump(run: AbortSignal, sources: Set<Promise<void>>): Promise<void> {
    while (this.isRunActive(run)) {
      const gen = ++this.generation
      const ac = new AbortController()
      this.current = ac

      let sourceReady = false
      let resolveReady!: (host: ConnectionHostInfo) => void
      let rejectReady!: (error: Error) => void
      let rejectSourceLost!: (error: Error) => void
      const ready = new Promise<ConnectionHostInfo>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const sourceLost = new Promise<never>((_resolve, reject) => {
        rejectSourceLost = reject
      })
      const reportReady = (host: ConnectionHostInfo): void => {
        if (sourceReady || ac.signal.aborted) return
        sourceReady = true
        resolveReady(host)
      }

      const failed = new Promise<void>((resolve) => {
        const aborted = (): void => { resolve() }
        ac.signal.addEventListener('abort', aborted, { once: true })
        const settle = (): void => {
          ac.signal.removeEventListener('abort', aborted)
          if (gen === this.generation && !ac.signal.aborted) ac.abort()
          resolve()
        }
        const task = Promise.resolve()
          .then(() => {
            ac.signal.throwIfAborted()
            return this.source(ac.signal, reportReady)
          })
          .then(
            () => {
              const error = new Error('connection generation ended')
              if (!sourceReady) rejectReady(error)
              rejectSourceLost(error)
              settle()
            },
            (reason: Thrown) => {
              const failure = reason instanceof Error
                ? reason
                : new Error('connection generation failed', { cause: reason })
              if (!sourceReady) rejectReady(failure)
              rejectSourceLost(failure)
              settle()
            },
          ).finally(() => { sources.delete(task) })
        sources.add(task)
      })

      const handshake = await Promise.race([
        waitForReady(ready, this.config.generationReadyTimeoutMs, ac.signal).then(
          handshakeReady,
          handshakeUnavailable,
        ),
        sourceLost.then(undefined, handshakeUnavailable),
      ])
      if (handshake.kind === 'ready' && !ac.signal.aborted) {
        this.attempt = 0
        let sinksSettled = false
        using _abortIfSinkThrows = {
          [Symbol.dispose]: (): void => {
            if (sinksSettled) return
            if (gen === this.generation && !ac.signal.aborted) ac.abort()
          },
        }
        this.emitState('connected')
        if (this.isGenerationActive(ac)) {
          this.sinks.onConnected?.(handshake.host)
        }
        sinksSettled = true
      } else if (!ac.signal.aborted) {
        ac.abort()
      }

      await failed
      if (!this.isRunActive(run)) return
      this.emitState('reconnecting')
      this.attempt += 1
      console.warn(`[connection] connection lost, retry #${this.attempt}`)
      await sleep(this.backoffDelay(this.attempt), run)
    }
  }

  /** Deduplicated state emission. */
  private emitState(state: ConnectionState): void {
    if (this.lastState === state) return
    this.lastState = state
    this.sinks.onStateChange?.(state)
  }
}

/** Await source readiness without letting a stalled carrier wedge startup forever. */
export async function waitForReady<T>(ready: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  const deadline = Promise.withResolvers<never>()
  const timeout = setTimeout(() => {
    deadline.reject(new Error(`connection generation was not ready within ${String(timeoutMs)}ms`))
  }, timeoutMs)
  const aborted = (): void => {
    deadline.reject(new Error('connection generation aborted', { cause: signal.reason }))
  }
  signal.addEventListener('abort', aborted, { once: true })
  if (signal.aborted) aborted()
  using _clearReadyWait = {
    [Symbol.dispose]: (): void => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', aborted)
    },
  }
  return await Promise.race([ready, deadline.promise])
}
