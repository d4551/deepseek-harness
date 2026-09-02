/**
 * TypeScript client SDK for the DeepSeek Harness runtime: spawn the
 * same-version `dsh --profile sdk` runtime as a subprocess and drive agent
 * turns over stdio JSON-RPC. This module owns `DeepSeekHarness`, the
 * high-level run API; `HarnessClient` is the lower-level protocol client. A
 * pure library — it registers nothing on a Cordis context; named profiles and
 * ordered patch files customize the runtime process it spawns.
 *
 * @module @deepseek-ai/dsh-sdk-client
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { HarnessSession } from './api.ts'
import { HarnessClient } from './client.ts'
import type { RunOptions } from './api.ts'
import type { DeepSeekHarnessOptions, RunResult, SdkPromptContentBlock } from './types.ts'

export { HarnessSession } from './api.ts'
export type { RunOptions } from './api.ts'
export {
  HarnessClient,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
} from './client.ts'
export type { NotificationSubscription } from './client.ts'
export { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
export type {
  ContentBlock,
  SdkPromptContentBlock,
  DeepSeekHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  RunResult,
} from './types.ts'

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export class DeepSeekHarness implements AsyncDisposable {
  private clientInstance: HarnessClient
  private readonly createClient: () => HarnessClient
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly reasoningEffort: DeepSeekHarnessOptions['reasoningEffort']
  private readonly maxTokens: number | undefined
  private initialized: Promise<void> | undefined
  private closed = false

  /** @param options - dsh launch configuration plus the session route, effort, and output cap. */
  constructor(options?: DeepSeekHarnessOptions)
  constructor(options: DeepSeekHarnessOptions = {}, clientFactory?: () => HarnessClient) {
    this.createClient = clientFactory ?? (() => new HarnessClient(options))
    this.clientInstance = this.createClient()
    // Absolute before the handshake: the child spawns relative to THIS
    // process's cwd, but the wire cwd is resolved again inside the child — a
    // relative value would double-resolve (e.g. `worker` → `worker/worker`).
    this.cwd = resolve(options.cwd ?? options.processCwd ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.reasoningEffort = options.reasoningEffort
    this.maxTokens = options.maxTokens
  }

  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake swaps in a fresh instance only after cleanup proves the runtime
   * exited; cleanup failure retains this client, so do not cache it across a
   * failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure, successful SDK-owned cleanup reaps the runtime and installs a
   * fresh client (`HarnessClient.close` is permanent), so a later call retries
   * with a new subprocess unless {@link close} already ended this harness. If
   * cleanup also fails, rejects with an `AggregateError` whose ordered errors
   * preserve both causes and retains the failed client rather than spawning
   * alongside a process whose exit was not proved.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start()
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
        })
      } catch (error) {
        this.initialized = undefined
        try {
          await this.clientInstance.close()
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'DeepSeek Harness initialization and cleanup failed',
          )
        }
        if (!this.closed) this.clientInstance = this.createClient()
        throw error
      }
    })()
    return this.initialized
  }

  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @returns the session handle.
   */
  session(sessionId?: string): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string | SdkPromptContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId).run(input, options)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}
