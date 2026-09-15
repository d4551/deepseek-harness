/**
 * Newline-delimited JSON-RPC 2.0 over byte streams. Frames with `id` and
 * `method` are requests, `id` alone is a response, and `method` alone is a
 * notification. Malformed lines are ignored; request handler failures become
 * error frames, while notification and write failures close the transport.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/transport
 */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

type JsonRpcId = string | number
type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>
type NotificationHandler = (method: string, params: Record<string, unknown>) => void | Promise<void>

/** A JSON-RPC error response, preserving the wire `code` and optional `data`. */
export class JsonRpcResponseError extends Error {
  /**
   * @param code - the wire error code, or `undefined` when the peer sent none.
   * @param message - the wire error message.
   * @param data - the optional structured error payload, verbatim.
   */
  constructor(readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'JsonRpcResponseError'
  }
}

/**
 * Outbound request and notification surface used by the runtime server and
 * SDK clients.
 */
export interface JsonRpcTransportPeer {
  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @returns the result; rejects with {@link JsonRpcResponseError} on an error
   * response, and with a plain `Error` on a write failure or closure.
   */
  request(method: string, params: object): Promise<unknown>
  /**
   * Send a notification; omitted params produce no `params` member.
   * @param method - the JSON-RPC method name.
   * @param params - the optional notification parameters object.
   */
  notify(method: string, params?: object): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** The first terminal edge, before dispatched handlers have drained. */
export interface JsonRpcTransportClosing {
  readonly kind: 'failure' | 'input-end' | 'local'
  readonly reason: Error
}

/**
 * Line-delimited endpoint over caller-owned streams. {@link start} attaches
 * listeners; {@link close} detaches them and rejects pending requests without
 * destroying the streams. Missing request handlers return `-32601`; handler
 * failures return `-32603`. Notification handler failures close the transport;
 * {@link closed} retains the first terminal reason. Notifications without a
 * handler are dropped.
 */
export class JsonRpcLineTransport implements JsonRpcTransportPeer {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private started = false
  private requestHandler: RequestHandler | undefined
  private notificationHandler: NotificationHandler | undefined
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly closure = Promise.withResolvers<Error>()
  private readonly closureStarted = Promise.withResolvers<JsonRpcTransportClosing>()
  private closedReason: Error | undefined
  private readonly closingFrameFailures: Error[] = []
  private nextFrame = 0
  private readonly frames = new Map<number, Promise<void>>()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  /**
   * Settles after dispatched frames finish, with the first terminal reason
   * plus subsequent frame failures in an AggregateError. The fulfilled
   * outcome remains available even when no request was pending.
   */
  get closed(): Promise<Error> {
    return this.closure.promise
  }

  /** Allows the owner to cancel its work before joining {@link closed}. */
  get closing(): Promise<JsonRpcTransportClosing> {
    return this.closureStarted.promise
  }

  /** Attach the input listeners and begin reading frames. Idempotent. */
  start(): void {
    if (this.closedReason !== undefined) throw this.closedReason
    if (this.started) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    this.output.on('error', this.onOutputError)
  }

  /**
   * Detach listeners and reject pending and future requests. Safe before
   * {@link start}; the first reason remains authoritative on repeated closure.
   * @param reason - the terminal failure, or an explicit local-close error.
   */
  close(reason?: Error): void {
    this.beginClosure(reason === undefined
      ? { kind: 'local', reason: new Error('JSON-RPC transport closed') }
      : { kind: 'failure', reason })
  }

  private beginClosure(closure: JsonRpcTransportClosing): void {
    if (this.closedReason !== undefined) return
    const { reason } = closure
    this.closedReason = reason
    this.closureStarted.resolve(closure)
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    if (this.started) this.output.off('error', this.onOutputError)
    this.buffer = ''
    this.failPending(reason)
    this.settleClosure()
  }

  /**
   * Install the request handler, replacing any prior handler.
   * @param handler - resolves to the response `result`; a rejection becomes a
   * `-32603` error response carrying the message.
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * Install the notification handler, replacing any prior handler.
   * @param handler - invoked per notification with the method and normalized
   * params object. Throws and rejected promises terminate this transport and
   * reject its pending requests; notifications never receive error responses.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @param signal - optional abandonment signal: aborting removes the pending
   * entry (no state is retained for a response that may never come) and
   * rejects with the signal's reason.
   * @returns the result; rejects per {@link JsonRpcTransportPeer.request}.
   */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(this.closedReason)
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      let detach = (): void => {}
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal.reason))
          return
        }
        const onAbort = (): void => {
          this.pending.delete(id)
          reject(abortError(signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.pending.set(id, {
        resolve: (value) => {
          detach()
          resolve(value)
        },
        reject: (error) => {
          detach()
          reject(error)
        },
      })
      try {
        this.write(message)
      } catch (error) {
        this.pending.delete(id)
        detach()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: object): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Wait for prior frame write callbacks. The empty barrier emits no bytes.
   * @returns a promise that settles with the output write callback.
   */
  flush(): Promise<void> {
    if (this.closedReason !== undefined) return Promise.reject(this.closedReason)
    return new Promise<void>((resolve, reject) => {
      this.output.write('', (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    this.drainLines()
  }

  private drainLines(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const frameId = this.nextFrame++
      const completion = Promise.withResolvers<void>()
      this.frames.set(frameId, completion.promise)
      completion.resolve(Promise.allSettled([this.handleLine(line)]).then(([outcome]) => {
        this.frames.delete(frameId)
        if (outcome.status === 'rejected') {
          const reason: unknown = outcome.reason
          const failure = reason instanceof Error ? reason : new Error(String(reason))
          if (this.closedReason === undefined) this.close(failure)
          else if (failure !== this.closedReason) this.closingFrameFailures.push(failure)
        }
        this.settleClosure()
      }))
    }
  }

  private readonly onInputError = (error: Error): void => {
    this.close(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.close(error)
  }

  private readonly onInputEnd = (): void => {
    this.buffer += this.decoder.end()
    this.drainLines()
    this.beginClosure({ kind: 'input-end', reason: new Error('JSON-RPC input closed') })
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // Only JSON syntax errors reach this catch; malformed peer lines are ignored.
      return
    }
    if (!message || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      await this.handleIncomingRequest(id, method, objectParams(frame.params))
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      this.handleIncomingResponse(id, frame)
      return
    }
    if (typeof method === 'string') {
      await this.notificationHandler?.(method, objectParams(frame.params))
    }
  }

  private async handleIncomingRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.requestHandler
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`)
      return
    }
    const request = new Promise<unknown>((resolve) => { resolve(handler(method, params)) })
    const [outcome] = await Promise.allSettled([request])
    if (outcome.status === 'fulfilled') this.write({ jsonrpc: '2.0', id, result: outcome.value })
    else {
      const reason: unknown = outcome.reason
      this.writeError(id, -32603, reason instanceof Error ? reason.message : String(reason))
    }
  }

  private handleIncomingResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Record<string, unknown>
      pending.reject(new JsonRpcResponseError(
        typeof error.code === 'number' ? error.code : undefined,
        typeof error.message === 'string' ? error.message : 'JSON-RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(message: Record<string, unknown>): void {
    if (this.closedReason !== undefined) throw this.closedReason
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }

  private settleClosure(): void {
    if (this.closedReason === undefined || this.frames.size > 0) return
    this.closure.resolve(this.closingFrameFailures.length === 0
      ? this.closedReason
      : new AggregateError(
        [this.closedReason, ...this.closingFrameFailures],
        'JSON-RPC transport closed with frame failures',
        { cause: this.closedReason },
      ))
  }
}

/** Normalize JSON-RPC `params` to a plain object (arrays and scalars collapse to `{}`). */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
}

/** Normalize an abort reason into the rejection Error (a non-Error reason is stringified). */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(`JSON-RPC request aborted: ${String(reason)}`)
}
