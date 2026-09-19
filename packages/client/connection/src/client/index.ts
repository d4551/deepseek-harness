/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets API Gateway own the connection loop.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  ConnectionController,
  type ConnectionConfig,
  type ConnectionGeneration,
  type ConnectionGenerationSource,
  type ConnectionSinks,
} from './connection.ts'
import { createFixtureConnectionRpc } from './fixture.ts'
import { createWebConnectionRpc, type RpcFetch, type RpcStreamOpen } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A connection generation was established. Wire-derived caches must
     * repull; long-lived streams own their own resume and baseline lifecycle.
     * @mode emit
     */
    'connection/reset'(): void
  }
}

// ---- Browser-safe protocol and shared value re-exports ----
export type {
  MessageId,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, RpcMessage,
  SessionId, SessionEvent, ContentBlock, StreamChunk,
} from './api.ts'
export {
  RpcId,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type {
  ConnectionConfig,
  ConnectionGeneration,
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionSinks,
  ConnectionState,
} from './connection.ts'
export type {
  ClientConnectionRpc, ConnectionRpcFailure, ConnectionRpcResult,
} from '../rpc.ts'
export type { RpcFetch } from './rpc.ts'

/** Observable identity and Host facts for the active connection generation. */
export interface ConnectionGenerationState {
  /** Active generation, or undefined before readiness and while reconnecting. */
  getSnapshot(): ConnectionGeneration | undefined
  /** Subscribe to generation establishment, replacement, and loss. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * Carrier override installed on the page global before plugin boot. The served
 * web app leaves it unset and gets HTTP + WebSocket; a shell that owns a
 * different physical transport (the worker preview's postMessage tunnel)
 * provides both halves here instead of forking this plugin.
 */
export interface ClientTransportHooks {
  /** Transport for generic unary RPC channels (the Typert gateway). */
  fetch: RpcFetch
  /** Worker-local Gateway stream carrier; absent when the page uses the Gateway WebSocket. */
  openStream?: RpcStreamOpen
  /**
   * Bundle transport for the module system, present when the carrier also owns
   * bundle bytes (the worker tunnel). Absent in the served web app, whose
   * bundles load over HTTP.
   */
  loadBundle?(url: string): Promise<void>
  /**
   * The transport owner declares the page owns the Host outright: the Host
   * runs inside a worker this page spawned, so no other party can reach it and
   * the loopback stand-in for "the operator's own machine" is vacuous.
   * `ctx.connection.isLoopback` then reports the privileged surface reachable
   * regardless of the page authority. Only a shell that assembles its own
   * transport can set this; served pages never carry the global at all.
   */
  ownsHost?: boolean
}

function isClientTransportHooks(value: object): value is ClientTransportHooks {
  if (!('fetch' in value) || typeof value.fetch !== 'function') return false
  if ('openStream' in value && value.openStream !== undefined && typeof value.openStream !== 'function') {
    return false
  }
  if ('loadBundle' in value && value.loadBundle !== undefined && typeof value.loadBundle !== 'function') {
    return false
  }
  if ('ownsHost' in value && value.ownsHost !== undefined && typeof value.ownsHost !== 'boolean') {
    return false
  }
  return true
}

function transportHooksOf(value: object): ClientTransportHooks | undefined {
  if (!('__DSH_TRANSPORT__' in value)) return undefined
  const hooks = value.__DSH_TRANSPORT__
  if (hooks === undefined) return undefined
  if (hooks === null || typeof hooks !== 'object') {
    throw new Error('connection: __DSH_TRANSPORT__ is not an object')
  }
  if (!isClientTransportHooks(hooks)) {
    throw new Error('connection: __DSH_TRANSPORT__ is missing a fetch function')
  }
  return hooks
}

/**
 * The ctx.connection service API: the API client plus a one-shot controller
 * starter. API Gateway supplies generation readiness and reset callbacks;
 * Connection stays independent of downstream domain state.
 */
export interface ConnectionHandle {
  /**
   * Whether the privileged surface is reachable: the page authority is
   * loopback, the transport declares the page owns the Host
   * ({@link ClientTransportHooks.ownsHost}), or the context is not a browser.
   */
  readonly isLoopback: boolean
  /** Current Remote event generation and the Host facts carried by its opening frame. */
  readonly generation: ConnectionGenerationState
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Register the sole source defining Host generations. The source reports
   * ready only after its incremental listeners are attached.
   * @param source - long-lived generation source owned by the push carrier.
   * @returns disposer withdrawing the source immediately and awaiting its started generations.
   */
  registerGenerationSource(source: ConnectionGenerationSource): () => Promise<void>
  /**
   * Start the connect/reconnect loop with the consumer's state callbacks.
   * API Gateway owns the loop; a second call throws.
   * @param sinks - connection-state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns handle that cancels immediately and awaits the loop and its retiring generations. `settled` rejects when a sink throws.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): {
    stop(): Promise<void>
    /** Settlement of the connect loop; a sink throw rejects it. */
    readonly settled: Promise<void>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Browser Connection transport and generation face. */
    connection: ConnectionHandle
  }
}

interface ConnectionOwner {
  readonly token: object
  readonly source: ConnectionGenerationSource
  readonly controller: ConnectionController
  readonly dispose: () => Promise<void>
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureRpc = fixture ? createFixtureConnectionRpc() : undefined
  const transport = transportHooksOf(globalThis)
  const rpc = fixtureRpc ?? createWebConnectionRpc(transport?.fetch, transport?.openStream)
  let generationSource: {
    readonly source: ConnectionGenerationSource
    readonly owners: Map<object, ConnectionOwner>
  } | undefined
  let owner: ConnectionOwner | undefined
  let generationId = 0
  let generation: ConnectionGeneration | undefined
  const generationListeners = new Set<() => void>()
  const publishGeneration = (next: ConnectionGeneration | undefined): void => {
    if (Object.is(generation, next)) return
    generation = next
    for (const listener of generationListeners) {
      listener()
    }
  }
  const releaseOwner = async (current: ConnectionOwner): Promise<void> => {
    await current.dispose()
    await current.controller.stop()
  }
  const handle: ConnectionHandle = {
    isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener) => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    },
    rpc,
    registerGenerationSource(source) {
      if (generationSource !== undefined) {
        throw new Error('connection: a generation source is already registered')
      }
      const registration = { source, owners: new Map<object, ConnectionOwner>() }
      generationSource = registration
      return async () => {
        if (generationSource === registration) generationSource = undefined
        const results = await Promise.allSettled([...registration.owners.values()].map(releaseOwner))
        const failures = results.filter(result => result.status === 'rejected')
        if (failures.length > 0) {
          throw new AggregateError(failures.map(result => result.reason), 'connection source disposal failed')
        }
      }
    },
    start(sinks, config) {
      if (owner !== undefined) throw new Error('connection: the stream loop is already owned by another consumer')
      const registration = generationSource
      if (registration === undefined) throw new Error('connection: no generation source is registered')
      const { source } = registration
      const token = {}
      const ownsGeneration = (): boolean => owner?.token === token
      const controller = new ConnectionController(source, {
        ...sinks,
        onConnected: (host) => {
          const nextGeneration = { id: ++generationId, host }
          publishGeneration(nextGeneration)
          if (!ownsGeneration() || !Object.is(generation, nextGeneration)) return
          sinks.onConnected?.(host)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') {
            publishGeneration(undefined)
          }
          if (!ownsGeneration()) return
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      const dispose = ctx.effect(() => () => {
        if (ownsGeneration()) {
          owner = undefined
          publishGeneration(undefined)
        }
        const stopping = controller.stop()
        stopping.then(
          () => { registration.owners.delete(token) },
          () => { registration.owners.delete(token) },
        )
        return stopping
      }, 'connection.generation')
      const current = { token, source, controller, dispose }
      registration.owners.set(token, current)
      owner = current
      const settled = controller.start()
      return {
        stop: () => releaseOwner(current),
        settled,
      }
    },
  }
  ctx.provide('connection', handle)
}
