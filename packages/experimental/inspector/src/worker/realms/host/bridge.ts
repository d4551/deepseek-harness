/** Per-DevTools-connection bridge to the Host main thread's real V8 inspector target. */

import { Session } from 'node:inspector'
import type { NativeProtocolNotification } from '../../../shared/cdp/realm.ts'

/** Notification emitted by Node's native inspector session. */
export type HostInspectorNotification = NativeProtocolNotification

/**
 * Period of the loop turn held while this Worker awaits the Host main thread.
 *
 * `connectToMainThread()` carries the main thread's answer back to this Worker through a runtime
 * wakeup that a Worker loop parked with no other work can miss. Measured on a loaded host, answers
 * that V8 had already produced stayed undelivered for eight and for thirty seconds, and an
 * unreferenced timer of this period in the Worker removed every stall. The value bounds the delay a
 * missed wakeup can add; it is not a deadline, so no request fails when it elapses, and the timer
 * runs only while requests are outstanding and never keeps the Worker alive.
 */
const HOST_ANSWER_WAKEUP_MS = 100

interface DynamicInspectorSession {
  connectToMainThread(): void
  disconnect(): void
  on(event: 'inspectorNotification', listener: (message: HostInspectorNotification) => void): this
  post(
    method: string,
    params: Readonly<Record<string, unknown>> | undefined,
    callback: (error: Error | null, result?: Readonly<Record<string, unknown>>) => void,
  ): void
}

/** Connection-local carrier for requests and notifications from the Host V8 inspector. */
export class HostInspectorSession {
  private readonly session = new Session() as unknown as DynamicInspectorSession
  private readonly listeners = new Set<(message: HostInspectorNotification) => void>()
  private connected = false
  private failure: string | undefined
  private outstanding = 0
  private wakeup: ReturnType<typeof setInterval> | undefined

  constructor(private readonly contextName: string) {
    this.session.on('inspectorNotification', (message) => {
      const rewritten = this.rewriteContextName(message)
      for (const listener of [...this.listeners]) {
        try {
          listener(rewritten)
        } catch {
          // One domain subscriber cannot starve notifications for sibling domains.
        }
      }
    })
  }

  /**
   * Subscribe to native inspector notifications.
   * @param listener - Consumer owned by one Worker domain adapter.
   * @returns A disposer removing the consumer.
   */
  subscribe(listener: (message: HostInspectorNotification) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Execute one Host V8 request for a Worker-owned composite Runtime operation.
   * @param method - CDP method name.
   * @param params - Validated request parameters.
   * @returns The Host inspector result.
   */
  request(method: string, params: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    const failure = this.connect()
    if (failure !== undefined) return Promise.reject(new Error(failure))
    this.retainWakeup()
    return new Promise((resolve, reject) => {
      try {
        this.session.post(method, params, (error, result) => {
          this.releaseWakeup()
          if (error !== null) reject(error)
          else resolve(result ?? {})
        })
      } catch (error) {
        this.releaseWakeup()
        reject(new Error(renderError(error)))
      }
    })
  }

  /** Disconnect this DevTools client's V8 session. */
  close(): void {
    this.listeners.clear()
    if (!this.connected || this.failure !== undefined) return
    this.connected = false
    try {
      this.session.disconnect()
    } catch {
      // The underlying inspector session is already disconnected.
    }
  }

  private retainWakeup(): void {
    this.outstanding++
    this.wakeup ??= setInterval(turnLoop, HOST_ANSWER_WAKEUP_MS).unref()
  }

  private releaseWakeup(): void {
    this.outstanding--
    if (this.outstanding > 0 || this.wakeup === undefined) return
    clearInterval(this.wakeup)
    this.wakeup = undefined
  }

  private connect(): string | undefined {
    if (this.connected) return this.failure
    this.connected = true
    try {
      this.session.connectToMainThread()
    } catch (error) {
      this.failure = `Host V8 inspector is unavailable: ${renderError(error)}`
    }
    return this.failure
  }

  private rewriteContextName(message: HostInspectorNotification): HostInspectorNotification {
    if (message.method !== 'Runtime.executionContextCreated') return message
    const params = message.params
    const context = params?.context
    if (typeof context !== 'object' || context === null) return message
    const record = context as Readonly<Record<string, unknown>>
    const auxData = record.auxData
    if (typeof auxData !== 'object' || auxData === null || (auxData as Readonly<Record<string, unknown>>).isDefault !== true) {
      return message
    }
    return {
      method: message.method,
      params: {
        ...params,
        context: { ...record, name: this.contextName },
      },
    }
  }
}

/** Serializes accepted native notifications and isolates sibling consumers. */
export class HostNotificationChannel<Event> {
  private readonly listeners = new Set<(event: Event) => void>()
  private readonly unsubscribe: () => void
  private delivery = Promise.resolve()

  constructor(
    target: HostInspectorSession,
    private readonly accepts: (message: HostInspectorNotification) => boolean,
    private readonly project: (message: HostInspectorNotification) => Promise<Event | undefined>,
  ) {
    this.unsubscribe = target.subscribe((message) => { this.receive(message) })
  }

  /**
   * Subscribe to projected native notifications.
   * @param listener - Consumer invoked in subscription order.
   * @returns A disposer removing the consumer.
   */
  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release the native notification subscription and all consumers. */
  close(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  private receive(message: HostInspectorNotification): void {
    if (!this.accepts(message)) return
    this.delivery = this.delivery.then(async () => {
      const event = await this.project(message)
      if (event === undefined) return
      for (const listener of [...this.listeners]) {
        try {
          listener(event)
        } catch {
          // One notification consumer cannot prevent delivery to its siblings.
        }
      }
    }).catch(() => {
      // Malformed optional native notifications do not interrupt request handling.
    })
  }
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Turning the Worker loop is the whole effect; the tick itself carries no work. */
function turnLoop(): void {}
