/** Worker-owned routing between synthetic Client contexts and source generations. */

import { randomUUID } from 'node:crypto'
import type {
  ClientRuntimeCommand,
  ClientRuntimeError,
  ClientRuntimeResult,
} from '../../shared/bridge/messages/runtime/commands.ts'
import type {
  ClientConsoleEnabledFrame,
  ClientConsoleEventFrame,
} from '../../shared/bridge/messages/runtime/console-frames.ts'
import type { ClientRuntimeCapability, ClientRuntimeResponseFrame } from '../../shared/bridge/messages/runtime/frames.ts'
import { inspectorId } from '../../shared/identity.ts'
import type { ClientRemoteObjectHandle, ClientRuntimeRequestId, ClientRuntimeSessionId } from '../../shared/bridge/ids.ts'
import { INSPECTOR_PROTOCOL_VERSION, type InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import { sendClientSessionClosed } from './session.ts'
import type { InspectorSourceEvent, InspectorSourceRegistry } from './hub.ts'
import type { RuntimeConsoleBackendEvent } from '../../shared/cdp/console.ts'

/** One connected projection of a Client realm into a synthetic CDP execution context. */
export interface ClientRuntimeTarget {
  readonly contextId: number
  readonly uniqueContextId: string
  readonly source: InspectorSourceDescriptor
  readonly capability: ClientRuntimeCapability
}

/** Runtime target admission or removal. */
export type ClientRuntimeTargetEvent =
  | { readonly type: 'opened'; readonly target: ClientRuntimeTarget }
  | { readonly type: 'closed'; readonly target: ClientRuntimeTarget }

interface PendingRequest {
  readonly target: ClientRuntimeTarget
  readonly sessionId: ClientRuntimeSessionId
  readonly op: ClientRuntimeCommand['op']
  readonly resolve: (result: ClientRuntimeResult) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface ConsoleSubscription {
  readonly target: ClientRuntimeTarget
  readonly sessionId: ClientRuntimeSessionId
  readonly listener: (event: RuntimeConsoleBackendEvent<ClientRemoteObjectHandle>) => void
  /** Settles when the Client confirms it observes this session's Console calls. */
  readonly installed: PromiseWithResolvers<void>
  readonly timer: ReturnType<typeof setTimeout>
}

/** Error returned deliberately by the Client Runtime executor. */
export class ClientRuntimeRemoteError extends Error {
  constructor(readonly code: ClientRuntimeError['code'], message: string) {
    super(message)
  }
}

/** Runtime context registry and correlated Worker-to-Client request owner. */
export class ClientRuntimeRouter {
  private readonly targetsBySource = new Map<string, ClientRuntimeTarget>()
  private readonly pending = new Map<ClientRuntimeRequestId, PendingRequest>()
  private readonly consoleSubscriptions = new Set<ConsoleSubscription>()
  private readonly listeners = new Set<(event: ClientRuntimeTargetEvent) => void>()
  private readonly unsubscribeSources: () => void
  private nextContextId = -1
  private closed = false

  constructor(private readonly sources: InspectorSourceRegistry, private readonly timeoutMs: number) {
    this.unsubscribeSources = sources.subscribeEvents((event) => { this.receiveSourceEvent(event) })
  }

  /**
   * Snapshot all active Client execution contexts.
   * @returns Active targets in admission order.
   */
  targets(): ClientRuntimeTarget[] {
    return [...this.targetsBySource.values()]
  }

  /**
   * Resolve the Client target for one active source generation.
   * @param source - Source identity stored with a semantic node.
   * @returns Its active Runtime target, when the generation still matches.
   */
  bySource(source: InspectorSourceDescriptor): ClientRuntimeTarget | undefined {
    const target = this.targetsBySource.get(source.sourceId)
    return target?.source.generation === source.generation ? target : undefined
  }

  /**
   * Subscribe to synthetic execution-context lifecycle.
   * @param listener - Context lifecycle observer.
   * @returns A disposer that removes the observer.
   */
  subscribe(listener: (event: ClientRuntimeTargetEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Enable Console events for one Client realm and DevTools session.
   *
   * A Client installs its Console observer only when the enable frame arrives, so
   * this resolves on the Client's confirmation. Resolving on dispatch instead
   * loses every Console call the page makes in the gap.
   * @param target - Active Client realm.
   * @param sessionId - DevTools Runtime session retaining event arguments.
   * @param listener - Consumer of validated Client Console events.
   * @returns A disposer that disables this Console session.
   */
  async subscribeConsole(
    target: ClientRuntimeTarget,
    sessionId: ClientRuntimeSessionId,
    listener: (event: RuntimeConsoleBackendEvent<ClientRemoteObjectHandle>) => void,
  ): Promise<() => void> {
    const subscription = this.openConsole(target, sessionId, listener)
    try {
      await subscription.installed.promise
    } catch (error) {
      this.closeConsole(subscription)
      throw error
    }
    return () => { this.closeConsole(subscription) }
  }

  /**
   * Execute one typed command in its currently active source generation.
   * @param target - Active Client source and context.
   * @param sessionId - Calling DevTools Runtime session.
   * @param command - Validated Client Runtime operation.
   * @returns The correlated result, or a rejection on timeout or disconnect.
   */
  request(
    target: ClientRuntimeTarget,
    sessionId: ClientRuntimeSessionId,
    command: ClientRuntimeCommand,
  ): Promise<ClientRuntimeResult> {
    if (this.closed || this.targetsBySource.get(target.source.sourceId) !== target) {
      return Promise.reject(new Error('Client execution context is no longer available'))
    }
    const requestId = inspectorId<'ClientRuntimeRequestId'>(randomUUID(), 'requestId')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (pending === undefined) return
        this.cancelClientResponse(target.source, sessionId, requestId)
        this.rejectPending(requestId, new Error(`Client Runtime ${command.op} timed out after ${String(this.timeoutMs)}ms`))
      }, this.timeoutMs)
      timer.unref()
      this.pending.set(requestId, { target, sessionId, op: command.op, resolve, reject, timer })
      try {
        const sent = this.sources.send(target.source, {
          v: INSPECTOR_PROTOCOL_VERSION,
          t: 'client-runtime/request',
          sourceId: target.source.sourceId,
          generation: target.source.generation,
          sessionId,
          requestId,
          command,
        })
        if (!sent) this.rejectPending(requestId, new Error('Client execution context disconnected before dispatch'))
      } catch (error) {
        this.rejectPending(requestId, renderError(error))
      }
    })
  }

  /**
   * Close one realm-local Runtime session without notifying sibling Client realms.
   * @param target - Client realm that owns the session.
   * @param sessionId - Closing DevTools Runtime session.
   */
  closeTargetSession(target: ClientRuntimeTarget, sessionId: ClientRuntimeSessionId): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.target !== target || pending.sessionId !== sessionId) continue
      this.rejectPending(requestId, new Error('DevTools Runtime session closed'))
    }
    for (const subscription of [...this.consoleSubscriptions]) {
      if (subscription.target === target && subscription.sessionId === sessionId) {
        this.abandonConsole(subscription, 'DevTools Runtime session closed')
      }
    }
    sendClientSessionClosed(this.sources, target.source, {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'client-runtime/session-closed',
      sourceId: target.source.sourceId,
      generation: target.source.generation,
      sessionId,
    })
  }

  /** Stop routing and reject every outstanding operation. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeSources()
    for (const requestId of [...this.pending.keys()]) {
      this.rejectPending(requestId, new Error('Client Runtime router closed'))
    }
    for (const subscription of [...this.consoleSubscriptions]) {
      this.abandonConsole(subscription, 'Client Runtime router closed')
    }
    this.targetsBySource.clear()
    this.listeners.clear()
  }

  private openConsole(
    target: ClientRuntimeTarget,
    sessionId: ClientRuntimeSessionId,
    listener: (event: RuntimeConsoleBackendEvent<ClientRemoteObjectHandle>) => void,
  ): ConsoleSubscription {
    const installed = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      installed.reject(new Error(`Client Console enable timed out after ${String(this.timeoutMs)}ms`))
    }, this.timeoutMs)
    timer.unref()
    const subscription: ConsoleSubscription = { target, sessionId, listener, installed, timer }
    this.consoleSubscriptions.add(subscription)
    try {
      if (!this.sources.send(target.source, {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'client-console/enable',
        sourceId: target.source.sourceId,
        generation: target.source.generation,
        sessionId,
      })) {
        installed.reject(new Error('Client Console source disconnected before enable'))
      }
    } catch (error) {
      installed.reject(renderError(error))
    }
    return subscription
  }

  private abandonConsole(subscription: ConsoleSubscription, reason: string): void {
    if (!this.consoleSubscriptions.delete(subscription)) return
    clearTimeout(subscription.timer)
    subscription.installed.reject(new Error(reason))
  }

  private closeConsole(subscription: ConsoleSubscription): void {
    if (!this.consoleSubscriptions.has(subscription)) return
    this.abandonConsole(subscription, 'Client Console session closed before the Client confirmed it')
    try {
      this.sources.send(subscription.target.source, {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'client-console/disable',
        sourceId: subscription.target.source.sourceId,
        generation: subscription.target.source.generation,
        sessionId: subscription.sessionId,
      })
    } catch {
      // Source removal also disables Console observation in the Client.
    }
  }

  private receiveSourceEvent(event: InspectorSourceEvent): void {
    switch (event.type) {
      case 'opened':
        this.open(event.source)
        return
      case 'closed':
        this.remove(event.source, event.reason)
        return
      case 'client-runtime-response':
        this.settle(event.source, event.frame)
        return
      case 'client-console-enabled':
        this.consoleInstalled(event.source, event.frame)
        return
      case 'client-console-event':
        this.consoleEvent(event.source, event.frame)
        return
      case 'client-source-response':
        return
      default:
        assertNever(event)
    }
  }

  private open(source: InspectorSourceDescriptor): void {
    const capability = source.capabilities.find(
      (candidate): candidate is ClientRuntimeCapability => candidate.type === 'client-runtime',
    )
    if (capability === undefined) return
    const target: ClientRuntimeTarget = {
      contextId: this.nextContextId--,
      uniqueContextId: `dsh-client:${source.sourceId}:${source.generation}`,
      source,
      capability,
    }
    this.targetsBySource.set(source.sourceId, target)
    this.emit({ type: 'opened', target })
  }

  private remove(source: InspectorSourceDescriptor, reason: string): void {
    const target = this.targetsBySource.get(source.sourceId)
    if (target === undefined || target.source.generation !== source.generation) return
    this.targetsBySource.delete(source.sourceId)
    for (const [requestId, pending] of this.pending) {
      if (pending.target !== target) continue
      this.rejectPending(requestId, new Error(`Client execution context closed: ${reason}`))
    }
    for (const subscription of [...this.consoleSubscriptions]) {
      if (subscription.target === target) {
        this.abandonConsole(subscription, `Client execution context closed: ${reason}`)
      }
    }
    this.emit({ type: 'closed', target })
  }

  private consoleInstalled(source: InspectorSourceDescriptor, frame: ClientConsoleEnabledFrame): void {
    const target = this.targetsBySource.get(source.sourceId)
    if (target === undefined || target.source.generation !== source.generation) return
    for (const subscription of this.consoleSubscriptions) {
      if (subscription.target !== target || subscription.sessionId !== frame.sessionId) continue
      clearTimeout(subscription.timer)
      subscription.installed.resolve()
    }
  }

  private consoleEvent(source: InspectorSourceDescriptor, frame: ClientConsoleEventFrame): void {
    const target = this.targetsBySource.get(source.sourceId)
    if (target === undefined || target.source.generation !== source.generation) return
    for (const subscription of [...this.consoleSubscriptions]) {
      if (subscription.target !== target || subscription.sessionId !== frame.sessionId) continue
      try {
        subscription.listener(frame.event)
      } catch {
        // One DevTools Console session cannot disrupt sibling sessions.
      }
    }
  }

  private settle(source: InspectorSourceDescriptor, frame: ClientRuntimeResponseFrame): void {
    const pending = this.pending.get(frame.requestId)
    if (pending === undefined) {
      this.cancelClientResponse(source, frame.sessionId, frame.requestId)
      return
    }
    if (pending.target.source.sourceId !== source.sourceId
      || pending.target.source.generation !== source.generation
      || pending.sessionId !== frame.sessionId) {
      this.cancelClientResponse(source, frame.sessionId, frame.requestId)
      this.cancelClientResponse(pending.target.source, pending.sessionId, frame.requestId)
      this.rejectPending(frame.requestId, new Error('Client Runtime response correlation mismatch'))
      return
    }
    if (!frame.outcome.ok) {
      this.acknowledgeClientResponse(source, frame.sessionId, frame.requestId)
      this.rejectPending(frame.requestId, new ClientRuntimeRemoteError(frame.outcome.error.code, frame.outcome.error.message))
      return
    }
    if (frame.outcome.result.op !== pending.op) {
      this.cancelClientResponse(source, frame.sessionId, frame.requestId)
      this.rejectPending(frame.requestId, new Error(
        `Client Runtime response op ${frame.outcome.result.op} does not match ${pending.op}`,
      ))
      return
    }
    if (!this.acknowledgeClientResponse(source, frame.sessionId, frame.requestId)) {
      this.rejectPending(frame.requestId, new Error('Client execution context disconnected before acknowledgement'))
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(frame.requestId)
    pending.resolve(frame.outcome.result)
  }

  private acknowledgeClientResponse(
    source: InspectorSourceDescriptor,
    sessionId: ClientRuntimeSessionId,
    requestId: ClientRuntimeRequestId,
  ): boolean {
    try {
      return this.sources.send(source, {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'client-runtime/response-acknowledged',
        sourceId: source.sourceId,
        generation: source.generation,
        sessionId,
        requestId,
      })
    } catch {
      // A failed acknowledgement rejects the Worker request; source teardown releases Client handles.
      return false
    }
  }

  private cancelClientResponse(
    source: InspectorSourceDescriptor,
    sessionId: ClientRuntimeSessionId,
    requestId: ClientRuntimeRequestId,
  ): void {
    try {
      this.sources.send(source, {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'client-runtime/cancel',
        sourceId: source.sourceId,
        generation: source.generation,
        sessionId,
        requestId,
      })
    } catch {
      // Cancellation settlement does not depend on delivery to a source that may be closing.
    }
  }

  private rejectPending(requestId: ClientRuntimeRequestId, error: Error): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    pending.reject(error)
  }

  private emit(event: ClientRuntimeTargetEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // One CDP session cannot disrupt context delivery to another session.
      }
    }
  }
}

function renderError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function assertNever(value: never): never {
  throw new Error(`Unexpected source event: ${JSON.stringify(value)}`)
}
