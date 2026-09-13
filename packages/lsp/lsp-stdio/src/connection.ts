/**
 * A JSON-RPC endpoint over one language server spawned through the subprocess
 * capability. Owns id correlation, outbound requests/notifications, and inbound
 * server→client requests: it answers `workspace/configuration` from static
 * config, and rejects `workspace/applyEdit` (this host never applies edits or
 * runs commands). It caps stderr, surfaces framing/decoder failures as a
 * fatal close, and exposes tree-scoped termination through the handle so the
 * instance owns teardown; group/tree mechanics live in the subprocess
 * Service Provider.
 * @module @deepseek-ai/dsh-lsp-stdio/connection
 */

import type { Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { encodeMessage, MessageDecoder } from './framing.ts'

/** How to launch the server and answer its config requests. */
export interface ConnectionSpec {
  /** The resolved absolute executable path (no shell). */
  readonly command: string
  /** Arguments passed to the executable. */
  readonly args: readonly string[]
  /** The child's working directory (the canonical workspace). */
  readonly cwd: string
  /** Explicit child environment overrides; the subprocess provider owns its ambient scrub. */
  readonly env: Record<string, string>
  /** Largest single framed message accepted from the server. */
  readonly maxMessageBytes: number
  /** Largest stderr tail retained for diagnostics. */
  readonly maxStderrBytes: number
  /**
   * The subprocess spec's `graceMs`: the SIGTERM→SIGKILL window of
   * {@link LspConnection.terminate}'s escalation, and the bound for draining
   * pipes a surviving helper still holds after the server exits.
   */
  readonly killGraceMs: number
  /** Static answer to every `workspace/configuration` item. */
  readonly configuration: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Write one JSON-RPC message to the child stdin.
 * @param stdin - the spawned server stdin.
 * @param message - the unencoded JSON-RPC message.
 * @param done - callback that reports asynchronous stream settlement.
 */
export type ConnectionWriter = (
  stdin: Writable,
  message: unknown,
  done: (error?: Error | null) => void,
) => void

/** Spawn one subprocess for this connection (the provider passes `ctx.subprocess.spawn`). */
export type ConnectionSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle

const writeConnectionMessage: ConnectionWriter = (stdin, message, done) => {
  stdin.write(encodeMessage(message), done)
}

/** A live JSON-RPC endpoint bound to one child process. */
export class LspConnection {
  private readonly handle: SubprocessHandle
  private readonly stdin: Writable
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closeReason: Error | undefined
  private readonly protocolWork = new Set<Promise<void>>()
  private readonly protocolFailures: Error[] = []
  private readonly writes = new Set<Promise<[PromiseSettledResult<void>]>>()
  private incoming: Promise<void> = Promise.resolve()
  /** Set once the process has fully exited; the instance awaits it during teardown. */
  readonly closed: Promise<void>

  /**
   * @param spec - how to launch the server and answer its config requests.
   * @param spawner - the subprocess seam's spawn (the provider passes `ctx.subprocess.spawn`).
   * @param onServerRequest - answers a server→client request; rejects to send an error response.
   * @param writer - message writer; tests inject callback failures without relying on OS pipe races.
   */
  constructor(
    spec: ConnectionSpec,
    spawner: ConnectionSpawner,
    private readonly onServerRequest: (method: string, params: unknown) => Promise<unknown>,
    private readonly writer: ConnectionWriter = writeConnectionMessage,
  ) {
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    // stdin/stdout are piped protocol streams this endpoint frames itself;
    // stderr is a collected diagnostic tail (no spill — the bounded tail IS
    // the contract). The seam owns detachment and tree-scoped signalling.
    this.handle = spawner({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: spec.maxStderrBytes },
      },
      graceMs: spec.killGraceMs,
      // The seam merges explicit config entries after its ambient scrub, so a
      // configured credential or DSH_* fact reaches the child deliberately.
      env: spec.env,
    })
    if (this.handle.stdin === undefined || this.handle.stdout === undefined) {
      throw new Error('lsp-stdio: subprocess implementation dropped a piped protocol stream')
    }
    this.stdin = this.handle.stdin
    this.closed = this.finishClose()
    // Child stdin can fail while the process itself remains alive (for example, a server closes fd
    // 0). Treat that as a fatal connection error so pending requests reject immediately instead of
    // waiting for a process-close event that may never arrive.
    this.stdin.on('error', (error) => {
      this.ownProtocolWork(Promise.resolve().then(() => { this.breakConnection(error) }))
    })
    this.handle.stdout.on('data', (chunk: Buffer) => {
      this.incoming = Promise.allSettled([this.incoming.then(() => this.onStdout(chunk))])
        .then(([outcome]) => { this.recordProtocolFailure(outcome) })
    })
  }

  /** The child's pid, or `-1` when the spawn produced no pid. */
  get pid(): number {
    return this.handle.pid
  }

  /** The retained stderr tail, for diagnostics on a failed server. */
  get stderrTail(): string {
    const stderr = this.handle.collected.stderr
    if (stderr === undefined) throw new Error('lsp-stdio: subprocess implementation dropped collected stderr')
    return stderr.readFrom(0).text
  }

  /** Whether the transport has failed even if the child close event has not arrived yet. */
  get failed(): boolean {
    return this.closeReason !== undefined
  }

  /**
   * Test whether a caught error is this connection's retained fatal transport cause.
   * @param error - error caught by the instance or provider.
   * @returns `true` only when this connection produced that exact failure.
   */
  failedWith(error: unknown): boolean {
    return this.closeReason === error
  }

  /**
   * Send a request and await its result.
   * @param method - the JSON-RPC method.
   * @param params - the request params.
   * @returns the response result; rejects on an error response, write failure, or close.
   */
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closeReason !== undefined) throw this.closeReason
    const id = this.nextId++
    const response = Promise.withResolvers<unknown>()
    this.pending.set(id, response)
    const [result] = await Promise.all([
      response.promise,
      this.write({ jsonrpc: '2.0', id, method, params }),
    ])
    return result
  }

  /**
   * Send a notification (no id, no response).
   * @param method - the JSON-RPC method.
   * @param params - the notification params.
   * @returns a promise that settles when the framed notification has been written.
   */
  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Send a `$/cancelRequest` for an in-flight request id and await its write.
   * @param requestId - the numeric id of the request to cancel.
   * @returns completion of the cancellation write; rejects when the connection cannot send it.
   */
  cancel(requestId: number): Promise<void> {
    return this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } })
  }

  /**
   * The id the NEXT `request()` will use, so the instance can pre-arm a cancel.
   * @returns the numeric id the next request will be assigned.
   */
  peekNextId(): number {
    return this.nextId
  }

  /** Terminate the server's process tree (the seam's SIGTERM→grace→SIGKILL escalation; idempotent). */
  terminate(): void {
    this.handle.terminate()
  }

  /**
   * Wait until the owned process tree has exited.
   * @param signal - optional bound for the wait.
   * @returns `true` when the tree exited, or `false` when the signal aborted first.
   */
  async waitForProcessTreeExit(signal?: AbortSignal): Promise<boolean> {
    return await this.handle.waitForExit(signal)
  }

  private async onStdout(chunk: Buffer): Promise<void> {
    const [decoded] = await Promise.allSettled([Promise.resolve().then(() => this.decoder.push(chunk))])
    if (decoded.status === 'rejected') {
      this.breakConnection(asError(decoded.reason))
      return
    }
    for (const message of decoded.value) this.dispatch(message)
  }

  private dispatch(message: unknown): void {
    if (!isRecord(message)) return
    const frame = message
    const id = frame.id
    const method = frame.method
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      this.ownProtocolWork(this.handleServerRequest(id, method, frame.params))
      return
    }
    if (typeof method === 'string') {
      // Notifications have no JSON-RPC response id.
      return
    }
    if (typeof id === 'number') this.handleResponse(id, frame)
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const [response] = await Promise.allSettled([Promise.resolve().then(() => this.onServerRequest(method, params))])
    const message = response.status === 'fulfilled'
      ? { jsonrpc: '2.0', id, result: response.value }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: asError(response.reason).message } }
    const [written] = await Promise.allSettled([this.write(message)])
    if (written.status === 'rejected') {
      this.breakConnection(asError(written.reason))
    }
  }

  private handleResponse(id: number, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = frame.error
    if (isRecord(error)) {
      pending.reject(new Error(typeof error.message === 'string' ? error.message : 'LSP error response'))
      return
    }
    pending.resolve(frame.result)
  }

  private async write(message: unknown): Promise<void> {
    if (this.closeReason !== undefined) throw this.closeReason
    const writing = Promise.allSettled([new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null): void => {
        if (error === undefined || error === null) {
          resolve()
          return
        }
        reject(error)
      }
      this.writer(this.stdin, message, done)
    })])
    this.writes.add(writing)
    const [written] = await writing
    this.writes.delete(writing)
    if (written.status === 'rejected') {
      const failure = asError(written.reason)
      this.breakConnection(failure)
      throw failure
    }
  }

  private ownProtocolWork(work: Promise<void>): void {
    const owned = Promise.allSettled([work]).then(([outcome]) => {
      this.recordProtocolFailure(outcome)
      this.protocolWork.delete(owned)
    })
    this.protocolWork.add(owned)
  }

  private recordProtocolFailure(outcome: PromiseSettledResult<void>): void {
    if (outcome.status === 'rejected') this.protocolFailures.push(asError(outcome.reason))
  }

  private async finishClose(): Promise<void> {
    const [process] = await Promise.allSettled([this.handle.done])
    await this.incoming
    this.fail(process.status === 'rejected' ? asError(process.reason) : this.closeReason ?? new Error(this.exitMessage()))
    await Promise.all(this.protocolWork)
    await Promise.all(this.writes)
    if (this.protocolFailures.length > 0) {
      throw new AggregateError(this.protocolFailures, 'LSP protocol work failed during close')
    }
  }

  /** The exit-close error message, appending the retained stderr tail when the server wrote any. */
  private exitMessage(): string {
    const tail = this.stderrTail.trim()
    return tail === '' ? 'language server exited' : `language server exited; stderr: ${tail}`
  }

  private fail(error: Error): void {
    if (this.closeReason === undefined) this.closeReason = error
    this.failAll(error)
  }

  private breakConnection(error: Error): void {
    this.fail(error)
    this.handle.terminate()
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(error)
  }
}

/** Coerce an unknown thrown value to an `Error`. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Validate the JSON object boundary before selecting protocol fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
