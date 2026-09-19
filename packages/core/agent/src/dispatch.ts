/**
 * Agent-scoped dispatch and prompt assembly helpers. The fused dispatcher
 * {@link agentEvents} couples the agent subject to its scope carrier, so the
 * scope key and the payload's `agent` cannot diverge; repeat dispatchers (the
 * loop driver) build it once in the agent's constructor and reuse it.
 * @module @deepseek-ai/dsh-agent/dispatch
 */

import type { Context, Events, ReturnType as CordisReturn } from '@deepseek-ai/cordis'
import type { Promisify } from '@deepseek-ai/cosmokit'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from './types.ts'

/** Extract the parameter tuple from an event handler type (its `this` is not part of the tuple). */
type Params<F> = F extends (...args: infer P) => unknown ? P : never

/**
 * The event names whose subject is an agent: the handler's first parameter is
 * a payload object carrying the `agent` subject AND the handler declares a
 * `Scoped<Agent>` `this` (the scope-carrier contract). The `this` check keeps
 * accidental payload-happens-to-carry-an-Agent events (or zero-arg events,
 * whose parameter tuple would satisfy a bare rest-tuple check via callability)
 * out of the fused-dispatch surface.
 */
export type AgentSubjectEvent = {
  [K in keyof Events]: Events[K] extends (this: Scoped<Agent>, ...args: infer P) => unknown
    ? P extends [infer Payload, ...unknown[]]
      ? Payload extends { agent: Agent } ? K : never
      : never
    : never
}[keyof Events]

/** The full payload object of one agent-subject event. */
type PayloadOf<K extends AgentSubjectEvent> = Params<Events[K]> extends [infer Payload, ...unknown[]] ? Payload : never

/** The event arguments AFTER the payload: the waterfall `next` when present. */
type Tail<K extends AgentSubjectEvent> = Params<Events[K]> extends [unknown, ...infer R] ? R : never

/**
 * The payload as emit-side callers pass it: the full payload minus the agent
 * field, which the fused dispatcher injects so subject and scope key cannot
 * diverge.
 */
type PayloadRest<K extends AgentSubjectEvent> = Omit<PayloadOf<K> & object, 'agent'>

/** Injected subject plus caller fields; Cordis fused dispatch accepts this as unknown rest. */
type InjectedPayload<K extends AgentSubjectEvent> = { readonly agent: Agent } & PayloadRest<K>

/** Values a contained listener may reject or throw. */
export type ListenerFailure = object | string | number | boolean | bigint | symbol | null | undefined

/** Drop a fulfilled containment promise so only the rejection path is observed. */
function ignoreFulfilled(): undefined {
  return undefined
}

/**
 * The fused dispatcher {@link agentEvents} returns: each method dispatches the
 * named agent-subject event with the agent's scope carrier as `thisArg` and
 * the agent itself injected into the payload.
 */
export interface AgentEventDispatch {
  /**
   * Fire-and-forget notification in the agent's scope. Every listener is
   * invoked; synchronous throws and returned-promise rejections are logged and
   * contained per listener, so a notification cannot veto lifecycle progress
   * or starve a later observer.
   * @param name - the agent-subject event to emit.
   * @param payload - the event's payload fields; `agent` is injected.
   */
  emit<K extends AgentSubjectEvent>(name: K, payload: PayloadRest<K>): void
  /**
   * Awaited in-order dispatch (Cordis `serial`) in the agent's scope.
   * @param name - the agent-subject event to dispatch.
   * @param payload - the event's payload fields; `agent` is injected.
   * @returns the serial chain's result (the first bail value, if any).
   */
  serial<K extends AgentSubjectEvent>(name: K, payload: PayloadRest<K>): Promisify<CordisReturn<Events[K]>>
  /**
   * Around-middleware dispatch (Cordis `waterfall`) in the agent's scope. The
   * declared event parameters already end with the `next` callback, so `rest`
   * is exactly the event's arguments after the payload — the final element
   * being the innermost `next` (the default the listener chain wraps).
   * @param name - the agent-subject event to dispatch.
   * @param payload - the event's payload fields; `agent` is injected.
   * @param rest - the event's arguments after the payload (the `next` callback).
   * @returns the waterfall's composed result.
   */
  waterfall<K extends AgentSubjectEvent>(name: K, payload: PayloadRest<K>, ...rest: Tail<K>): CordisReturn<Events[K]>
}

function injectSubject<K extends AgentSubjectEvent>(agent: Agent, payload: PayloadRest<K>): InjectedPayload<K> {
  return { ...payload, agent }
}

/**
 * Run one emit listener and report a synchronous throw separately from a
 * returned-thenable rejection. The Promise executor converts a throw into a
 * rejection before the synchronous-completion flag is set.
 */
export function observeListenerInvocation(
  invoke: () => unknown,
  onThrow: (reason: ListenerFailure) => void,
  onReject: (reason: ListenerFailure) => void,
): void {
  let finishedSynchronously = false
  function report(reason: ListenerFailure): void {
    if (finishedSynchronously) onReject(reason)
    else onThrow(reason)
  }
  new Promise((resolve: (value: unknown) => void) => {
    resolve(invoke())
    finishedSynchronously = true
  }).then(ignoreFulfilled, report)
}

/**
 * Watch a value already returned from a listener. A throw at the call site
 * still escapes; only a thenable rejection is reported.
 */
export function observeReturnedThenable(
  returned: unknown,
  onReject: (reason: ListenerFailure) => void,
): void {
  Promise.resolve(returned).then(ignoreFulfilled, onReject)
}

/**
 * Render a contained listener failure. Hostile `toString` stays inside the
 * Promise executor so coercion cannot escape the notification path.
 */
export function renderListenerFailure(reason: ListenerFailure): string {
  let text = '[unrenderable thrown value]'
  new Promise((resolve: (value: string) => void) => {
    if (reason instanceof Error) {
      text = `${reason.name}: ${reason.message}`
    } else if (
      typeof reason === 'string'
      || typeof reason === 'number'
      || typeof reason === 'boolean'
      || typeof reason === 'bigint'
      || typeof reason === 'symbol'
    ) {
      text = String(reason)
    } else if (reason === null) {
      text = 'null'
    } else if (reason === undefined) {
      text = 'undefined'
    }
    resolve(text)
  }).then(ignoreFulfilled, ignoreFulfilled)
  return text
}

/**
 * Build the fused scope carrier for one agent subject.
 *
 * The carrier is a stateless routing object. {@link agentEvents} accepts an
 * existing carrier, so callers that dispatch repeatedly for the same agent
 * (the loop driver) build it once in the agent's constructor and reuse it,
 * keeping hot-path dispatches allocation-free.
 * @param agent - the subject agent and scope key.
 * @returns the carrier passed as the event dispatcher `this` value.
 */
export function agentCarrier(agent: Agent): Scoped<Agent> {
  return scopeTarget(agent, agent)
}

/**
 * Build a dispatcher that couples the agent subject to its scope carrier.
 * @param ctx - the context to dispatch through (any context of the app).
 * @param agent - the subject agent; also the scope-carrier key.
 * @param carrier - the scope carrier to dispatch through; defaults to
 * {@link agentCarrier} for the agent. Pass a constructor-built carrier to
 * avoid rebuilding it for every dispatch.
 * @returns the fused dispatcher.
 */
export function agentEvents(ctx: Context, agent: Agent, carrier: Scoped<Agent> = agentCarrier(agent)): AgentEventDispatch {
  return {
    emit(name, payload) {
      const args: unknown[] = [carrier, name, injectSubject(agent, payload)]
      for (const callback of ctx.events.dispatch('emit', args)) {
        observeListenerInvocation(
          () => callback(...args),
          (reason) => {
            ctx.logger.warn(`agent event "${name}" listener threw: ${renderListenerFailure(reason)}`)
          },
          (reason) => {
            ctx.logger.warn(`agent event "${name}" listener rejected: ${renderListenerFailure(reason)}`)
          },
        )
      }
    },
    serial(name, payload) {
      return ctx.serial(carrier, name, injectSubject(agent, payload))
    },
    waterfall(name, payload, ...rest) {
      return ctx.waterfall(carrier, name, injectSubject(agent, payload), ...rest)
    },
  }
}

/**
 * Emit one contained agent notification without allocating a retained dispatcher.
 * @param ctx - the context to dispatch through.
 * @param agent - the subject agent and scope key.
 * @param name - the agent-subject event to emit.
 * @param payload - the event's payload fields; `agent` is injected.
 */
export function emitAgentEvent<K extends AgentSubjectEvent>(
  ctx: Context,
  agent: Agent,
  name: K,
  payload: PayloadRest<K>,
): void {
  agentEvents(ctx, agent).emit(name, payload)
}

/**
 * Build the prompt assembly context with agent and scope set together, so
 * agent-scoped prompt and tool contributions cannot be silently omitted.
 * @param agent - the agent the assembly is for.
 * @param signal - the current turn's explicit control signal, when assembly belongs to a turn.
 * @returns the context to pass to `assemble()`.
 */
export function assembleContextFor(agent: Agent, signal?: AbortSignal): AssembleContext {
  return { agent, scope: agent, ...signal === undefined ? {} : { signal } }
}
