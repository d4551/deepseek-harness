/**
 * Event-sourced session service: append-only session log, in-memory store, and
 * the derived LLM message history. Persistence is a plugin concern (subscribe
 * to `session/event`, drain on `session/flush`).
 *
 * @module @deepseek-ai/dsh-session
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { deepFreeze, errorChain } from '@deepseek-ai/dsh-llm'
import { scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { Message } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId } from './types.ts'
import type { TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { CreateSessionOptions, EpochHeader, PrepareSessionOptions, RequestContext, SessionEvent, SessionEventMap, SessionEventType, SessionHeader, SurfaceIntent, SurfaceEventType } from './types.ts'
import { snapshotJsonValue } from './json.ts'
import { deriveEventMessage, SurfaceManager } from './surface.ts'
import type { SessionSurface } from './surface.ts'
import { foldRequestHeader } from './request-header.ts'
import { SessionRequestBudgets } from './request-budget.ts'

export { SESSION_FORMAT_VERSION, SessionId } from './types.ts'
export type { AgentCancelCause, CreateSessionOptions, EpochHeader, PrepareSessionOptions, RequestContext, RequestHeaderReason, RestoredSessionOptions, SessionEvent, SessionEventMap, SessionEventType, SessionHeader, SurfaceEvent, SurfaceEventType, SurfaceIntent, SurfaceOp, TurnEndCancelCause, TurnEndReason, TurnEndReasonMap } from './types.ts'
export { SessionPreparation } from './preparation.ts'
export type { SessionPreparationOptions } from './preparation.ts'
export type { AssistantMessage, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
export { hasPlainArrayPrototype, hasPlainObjectPrototype, isJsonValue, snapshotJsonValue } from './json.ts'
export type { JsonValue } from './json.ts'
export { interruptedTurnClosers, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './repair.ts'
export { decodeStorageRecord, packChunkRuns } from './chunk-rows.ts'
export type { ChunkRow, StorageRecord } from './chunk-rows.ts'
export type { SessionSurface, SurfaceContractReject, SurfaceFoldReplacement, SurfaceFoldResult } from './surface.ts'
export { deriveEventMessage, foldSurface, isAppendSurfaceEvent, isReplacementSurfaceEvent, isSurfaceEvent, isSurfaceEligibleType } from './surface.ts'
export { canonicalHeader, foldRequestHeader, headerEquals } from './request-header.ts'
export { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'
export { RequestBudgetExhausted } from './request-budget.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionStore
  }

  interface Events {
    /**
     * Creation announcement during session publication. A synchronous throw vetoes and rolls
     * back with a paired disposal; detach requested during dispatch is deferred.
     * A returned-promise rejection is logged but cannot retroactively veto this
     * synchronous boundary.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only sessions entered through that agent's context.
     * @param session - the session just entered and announced.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/created'(this: Scoped<Session>, session: Session): void
    /**
     * Emitted once when an announced session leaves the store, including
     * publication rollback, but never for an entry whose creation announcement
     * did not begin. Listener failures are logged and contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`) reuses the owner scope.
     * @param session - the session that is no longer live in the store.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/disposed'(this: Scoped<Session>, session: Session): void
    /**
     * Post-commit, fire-and-forget append feed. The listener snapshot resolves
     * before the log push, but callbacks run after it; observer failures are
     * logged and contained without making the committed append fail.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners
     * receive only events from sessions entered through that agent's context.
     * @param session - the session whose log grew.
     * @param event - the appended event, exactly as recorded.
     * @dshScopeScan unsupported
     * @mode emit
     */
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
    /**
     * Awaited parallel durability checkpoint: every listener runs and the
     * caller awaits all of them, with no waterfall veto. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`) reuses the session's owner scope.
     * @param session - the session whose buffered events must reach durable storage.
     * @dshScopeScan unsupported
     * @mode parallel
     */
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    session: TypertLookup<Session, SessionId>
  }
}

/** Validate and freeze one detached creation header in place. */
function validateSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session header is not a plain JSON record')
  }
  if (!('version' in input) || input.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`session header version must be ${SESSION_FORMAT_VERSION}`)
  }
  if (!('id' in input) || input.id !== id) {
    throw new Error('session header id does not match session id')
  }
  if (!('createdAt' in input)
    || typeof input.createdAt !== 'number'
    || !Number.isSafeInteger(input.createdAt)
    || input.createdAt < 0) {
    throw new Error('session header createdAt must be a non-negative safe integer')
  }
  const cwd = 'cwd' in input && input.cwd !== undefined
    ? input.cwd
    : undefined
  if (cwd !== undefined) {
    if (typeof cwd !== 'string') throw new Error('session header cwd must be a string')
    if (!isAbsolute(cwd)) {
      throw new Error(`session header cwd must be an absolute path, got "${cwd}"`)
    }
  }
  const parentSession = 'parentSession' in input && input.parentSession !== undefined
    ? input.parentSession
    : undefined
  if (parentSession !== undefined && typeof parentSession !== 'string') {
    throw new Error('session header parentSession must be a string')
  }
  const seedLength = 'seedLength' in input && input.seedLength !== undefined
    ? input.seedLength
    : undefined
  if (seedLength !== undefined
    && (typeof seedLength !== 'number' || !Number.isSafeInteger(seedLength) || seedLength < 0)) {
    throw new Error('session header seedLength must be a non-negative safe integer')
  }
  const origin = 'origin' in input && input.origin !== undefined
    ? input.origin
    : undefined
  if (origin !== undefined && origin !== 'subagent') {
    throw new Error('session header origin must be "subagent"')
  }
  const delegationDepth = 'delegationDepth' in input && input.delegationDepth !== undefined
    ? input.delegationDepth
    : undefined
  if (delegationDepth !== undefined
    && (typeof delegationDepth !== 'number' || !Number.isSafeInteger(delegationDepth) || delegationDepth < 0)) {
    throw new Error('session header delegationDepth must be a non-negative safe integer')
  }
  const agentPreset = 'agentPreset' in input && input.agentPreset !== undefined
    ? input.agentPreset
    : undefined
  if (agentPreset !== undefined && typeof agentPreset !== 'string') {
    throw new Error('session header agentPreset must be a string')
  }
  return deepFreeze({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: input.createdAt,
    ...cwd === undefined ? {} : { cwd },
    ...parentSession === undefined ? {} : { parentSession: SessionId(parentSession) },
    ...seedLength === undefined ? {} : { seedLength },
    ...origin === undefined ? {} : { origin },
    ...delegationDepth === undefined ? {} : { delegationDepth },
    ...agentPreset === undefined ? {} : { agentPreset },
  })
}

/** Validate and freeze one exclusively owned persistence header in place. */
function validateRestoredSessionHeader(id: SessionId, input: unknown): SessionHeader {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const prototype = Reflect.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('session header is not a plain JSON record')
    }
  }
  return validateSessionHeader(id, input)
}

/** Detach, validate, and freeze the creation metadata published by a session. */
function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader {
  const input: unknown = source === undefined
    ? { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now() }
    : source
  const snapshot = snapshotJsonValue(input)
  if (snapshot === undefined) throw new Error('session header is not losslessly JSON-serializable')
  return validateSessionHeader(id, snapshot)
}

/**
 * Validate an exclusively owned event and deeply freeze its identified message
 * without copying the event. The caller transfers an object graph that no
 * producer retains and that shares no mutable children with another event.
 * Use {@link snapshotSessionEvent} when exclusive ownership is not guaranteed.
 * @param event - exclusively owned event imported across a trusted boundary.
 * @returns the same event object with a validated, deeply frozen message.
 */
export function adoptSessionEvent<T extends SessionEvent>(event: T): T {
  assertMessageEventShape(
    event,
    `session event at seq ${event.seq}`,
  )
  switch (event.type) {
    case 'user/message':
      deepFreeze(event.data)
      break
    case 'assistant/message':
    case 'tool/result':
      deepFreeze(event.data.message)
      break
    default:
      // SessionEventMap is merge-extensible; plugin-owned events carry no core message.
      break
  }
  return event
}

/**
 * Detach one event while preserving deep immutability for its identified message.
 * @param event - event imported across a query or persistence boundary.
 * @returns a detached event snapshot with a validated, deeply frozen message.
 */
export function snapshotSessionEvent<T extends SessionEvent>(event: T): T {
  return adoptSessionEvent(structuredClone(event))
}

/** Confirm a constructed append payload is a session event before it enters the log. */
function assertPublishedSessionEvent(
  value: object,
  expectedType: string,
  expectedSeq: number,
): asserts value is SessionEvent {
  if (!('type' in value) || !('seq' in value) || !('time' in value) || !('data' in value)) {
    throw new Error(`session event "${expectedType}" is missing envelope fields`)
  }
  if (value.type !== expectedType) {
    throw new Error(`session event "${expectedType}" published a different type`)
  }
  if (typeof value.seq !== 'number' || value.seq !== expectedSeq) {
    throw new Error(`session event "${expectedType}" published an unexpected seq`)
  }
  if (typeof value.time !== 'number' || !Number.isSafeInteger(value.time)) {
    throw new Error(`session event "${expectedType}" has an invalid time`)
  }
}

/** Narrow a published event to the append call's type argument. */
function isSessionEventOfType<T extends SessionEventType>(
  event: SessionEvent,
  type: T,
): event is SessionEvent<T> {
  return event.type === type
}

/** Whether a seed type is the removed request/header-delta codec. */
function isLegacyRequestHeaderDelta(type: string): boolean {
  return type === 'request/header-delta'
}

/** Validate the fixed event envelope after one-pass JSON materialization. */
function assertSessionEventEnvelope(event: object, index: number): void {
  const type = 'type' in event ? event.type : undefined
  if (typeof type === 'string' && isLegacyRequestHeaderDelta(type)) {
    throw new Error(`seed event at index ${index} uses unsupported legacy request/header-delta format`)
  }
  for (const key in event) {
    switch (key) {
      case 'type':
      case 'seq':
      case 'time':
      case 'data':
      case 'surfaceOp':
      case 'sourceEventSeqs':
        break
      default:
        throw new Error(`seed event at index ${index} has an invalid event envelope`)
    }
  }
  const seq = 'seq' in event ? event.seq : undefined
  const time = 'time' in event ? event.time : undefined
  if (typeof type !== 'string'
    || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0
    || typeof time !== 'number' || !Number.isSafeInteger(time)
    || !('data' in event) || event.data === undefined) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
}

/** Reject obsolete request headers and malformed messages at the seed/load boundary. */
function assertCurrentLlmShape(event: object, index: number): void {
  if (!('type' in event)) return
  const type = event.type
  if (type === 'request/header') {
    const data = 'data' in event ? event.data : undefined
    const header = typeof data === 'object' && data !== null && 'header' in data
      ? data.header
      : undefined
    const config = typeof header === 'object' && header !== null && !Array.isArray(header) && 'config' in header
      ? header.config
      : undefined
    if (typeof config !== 'object' || config === null || !hasProviderModel(config)) {
      throw new Error(`seed request/header at index ${index} lacks provider/model`)
    }
    if ('reasoningEffort' in config && config.reasoningEffort !== undefined
      && (typeof config.reasoningEffort !== 'string' || config.reasoningEffort.length === 0)) {
      throw new Error(`seed request/header at index ${index} has an invalid reasoningEffort`)
    }
    const adapterDefaults = typeof header === 'object' && header !== null && !Array.isArray(header) && 'adapterDefaults' in header
      ? header.adapterDefaults
      : undefined
    if (adapterDefaults !== undefined
      && typeof adapterDefaults !== 'object'
      && typeof adapterDefaults !== 'string'
      && typeof adapterDefaults !== 'number'
      && typeof adapterDefaults !== 'boolean'
      && typeof adapterDefaults !== 'bigint'
      && typeof adapterDefaults !== 'symbol') {
      throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
    }
    assertAdapterDefaults(adapterDefaults, config, index)
  }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') {
    assertMessageEventShape(event, `seed ${type} at index ${index}`)
  }
}

const allowedAdapterKeys = new Set(['reasoningEffort', 'maxTokens'])

/** Validate adapter-default markers imported from a durable request header. */
function assertAdapterDefaults(
  value: object | string | number | boolean | bigint | symbol | null | undefined,
  config: object,
  index: number,
): void {
  if (value === undefined) return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
  const keys = Object.keys(value)
  if (keys.some(key => !allowedAdapterKeys.has(key))
    || Object.values(value).some(marker => marker !== true)
    || 'reasoningEffort' in value && value.reasoningEffort === true && !('reasoningEffort' in config)
    || 'maxTokens' in value && value.maxTokens === true && !('maxTokens' in config)) {
    throw new Error(`seed request/header at index ${index} has invalid adapterDefaults`)
  }
}

/** Validate only the event-specific invariants needed to safely replay a message. */
function assertMessageEventShape(event: object, subject: string): void {
  if (!('type' in event)) return
  const type = event.type
  if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return

  const data = 'data' in event ? event.data : undefined
  const message = type === 'user/message'
    ? data
    : typeof data === 'object' && data !== null && 'message' in data
      ? data.message
      : undefined
  const id = typeof message === 'object' && message !== null && 'id' in message
    ? message.id
    : undefined
  if (typeof message !== 'object' || message === null || typeof id !== 'string' || id === '') {
    throw new Error(`${subject} lacks an identified message`)
  }

  const expectedRole = type === 'assistant/message' ? 'assistant' : 'user'
  const role = 'role' in message ? message.role : undefined
  if (role !== expectedRole) {
    throw new Error(`${subject} message must have role "${expectedRole}"`)
  }

  const source = 'source' in message ? message.source : undefined
  const kind = typeof source === 'object' && source !== null && 'kind' in source
    ? source.kind
    : undefined
  if (typeof source !== 'object' || source === null || typeof kind !== 'string' || kind === '') {
    throw new Error(`${subject} message has invalid source`)
  }

  const content = 'content' in message ? message.content : undefined
  if (!Array.isArray(content)) {
    throw new Error(`${subject} message has invalid content`)
  }

  if (type === 'assistant/message') {
    if (kind !== 'model' || !hasProviderModel(source)) {
      throw new Error(`${subject} message must have model source`)
    }
    return
  }
  if (type !== 'tool/result') return

  const callId = 'callId' in source ? source.callId : undefined
  if (kind !== 'tool' || typeof callId !== 'string' || callId === '') {
    throw new Error(`${subject} message must have tool source`)
  }

  const block = content[0]
  const blockType = typeof block === 'object' && block !== null && 'type' in block
    ? block.type
    : undefined
  const blockContent = typeof block === 'object' && block !== null && 'content' in block
    ? block.content
    : undefined
  if (content.length !== 1 || typeof block !== 'object' || block === null
    || blockType !== 'tool-result' || !Array.isArray(blockContent)) {
    throw new Error(`${subject} message must contain one tool-result block`)
  }
  const toolCallId = 'toolCallId' in block ? block.toolCallId : undefined
  if (toolCallId !== callId) {
    throw new Error(`${subject} message has mismatched tool call ids`)
  }
}

/** Whether an unknown value carries the current provider/model pair. */
function hasProviderModel(value: object | string | number | boolean | bigint | symbol | null | undefined): boolean {
  if (typeof value !== 'object' || value === null) return false
  return 'provider' in value && typeof value.provider === 'string' && value.provider.length > 0
    && 'model' in value && typeof value.model === 'string' && value.model.length > 0
}

/** Reject request-header vocabulary removed with the legacy delta codec. */
function assertSupportedRequestHeader(type: string, data: unknown, location: string): void {
  if (type === 'request/header-delta') {
    throw new Error(`${location} uses unsupported legacy request/header-delta format`)
  }
  if (type === 'request/header'
    && data !== null && typeof data === 'object' && !Array.isArray(data)
    && 'reason' in data && data.reason === 'fallback') {
    throw new Error(`${location} uses unsupported legacy request/header reason "fallback"`)
  }
}

type SessionCallback = (...args: unknown[]) => unknown

/** Resolve one listener snapshot, including Cordis's internal dispatch checks. */
function collectSessionCallbacks(ctx: Context, args: unknown[]): SessionCallback[] {
  const callbacks: SessionCallback[] = []
  for (const callback of ctx.events.dispatch('emit', args)) {
    if (typeof callback !== 'function') {
      throw new Error('session dispatch produced a non-function listener')
    }
    callbacks.push(callback)
  }
  return callbacks
}

/** Values a contained listener may reject or throw. */
type ListenerFailure = object | string | number | boolean | bigint | symbol | null | undefined

/** Render a contained listener failure with the Error name plus the errorChain body. */
function renderContainedFailure(reason: ListenerFailure): string {
  const chain = errorChain(reason)
  if (reason instanceof Error && chain !== reason.name) return `${reason.name}: ${chain}`
  return chain
}

/** Run one emit listener and report a synchronous throw separately from a returned-thenable rejection. */
function observeListenerInvocation(
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
  }).then(ignoreFulfilledListener, report)
}

/** Drop a fulfilled containment promise so only the rejection path is observed. */
function ignoreFulfilledListener(): undefined {
  return undefined
}

/** Watch a value already returned from a listener. A throw at the call site still escapes. */
function observeReturnedThenable(
  returned: unknown,
  onReject: (reason: ListenerFailure) => void,
): void {
  Promise.resolve(returned).then(ignoreFulfilledListener, onReject)
}

/** Invoke one resolved observe-only listener snapshot with per-listener containment. */
function invokeContainedSessionObservers(
  ctx: Context,
  name: 'session/event' | 'session/disposed',
  id: SessionId,
  args: unknown[],
  callbacks: SessionCallback[],
): void {
  for (const callback of callbacks) {
    observeListenerInvocation(
      () => callback(...args),
      (reason) => {
        ctx.logger.warn(`session "${id}": ${name} listener threw: ${renderContainedFailure(reason)}`)
      },
      (reason) => {
        ctx.logger.warn(`session "${id}": ${name} listener rejected: ${renderContainedFailure(reason)}`)
      },
    )
  }
}

/** All mutable lifecycle state for one exact store entry. */
interface SessionEntry {
  readonly id: SessionId
  readonly session: Session
  readonly carrier: Scoped<Session>
  readonly emitCtx: Context
  announced: boolean
  announcing: boolean
  appending: boolean
  detachRequested: boolean
  detach(): void
}

/** Store attachment for the append path; module-private to keep Session store-agnostic publicly. */
const attachments = new WeakMap<Session, SessionEntry>()

/**
 * An event-sourced session: an append-only log of {@link SessionEvent}s.
 *
 * Plain class (not a Service) — create live instances via
 * `ctx.sessions.create()` and detached instances via {@link create}.
 * Seeding with an existing event log replays/forks a session.
 * @typert object
 */
export class Session {
  private log: SessionEvent[] = []
  /** Single incremental owner of surface acceptance and projection state. */
  private readonly surfaceManager = new SurfaceManager(this.log)

  /** The ordered surface over this session's event log. */
  get surface(): SessionSurface {
    return this.surfaceManager
  }

  /**
   * Detached, deep-frozen creation metadata (format version, cwd, lineage,
   * seed boundary). Supplied by the store via `ctx.sessions.create()`. When a
   * `Session` is created without a store-owned header, a minimal header is
   * synthesized (stamped with the current {@link SESSION_FORMAT_VERSION}) so
   * `session.header` is always present. Kept out of the event log — it is a
   * storage concern, not replayable conversation state.
   */
  readonly header: SessionHeader

  /** The session identity, derived from its durable header's single copy. */
  get id(): SessionId {
    return this.header.id
  }

  /**
   * The first seq appended IN THIS PROCESS: the length of the constructor
   * seed (0 without one). Events with smaller seq values entered through
   * construction — replay, fork, or resume — and were never published on the
   * `session/event` firehose (constructor seeds do not emit), so consumers
   * that replay the log as a publication substitute (telemetry adoption)
   * start here. Distinct from `header.seedLength`, the DURABLE fork-lineage
   * boundary: a resumed session's constructor seed is its full stored log,
   * while its header keeps the original fork value — this field is the
   * in-process construction fact.
   *
   * Not persisted itself: a seeded session projects it into the log as the
   * `session/end-seed` event, which is what a consumer reading STORED history
   * reads. Locate the LAST such event, not necessarily one at this seq — a
   * seed already ending in one is not re-marked, so reopening an untouched
   * session leaves that event at a smaller seq than `firstLiveSeq`. Prefer
   * this field in-process: it is exact before the marker reaches storage.
   *
   * When this lifecycle appends the marker, it occupies this seq before the
   * store attaches and therefore does not publish either. Otherwise this seq
   * holds an ordinary published write.
   */
  readonly firstLiveSeq: number

  /**
   * Create a detached session by validating and snapshotting borrowed seed
   * events and storage metadata.
   * @param id - session identity.
   * @param seed - optional borrowed replay or fork events.
   * @param header - optional borrowed storage metadata.
   * @returns a detached session.
   */
  static create(id: SessionId, seed?: readonly SessionEvent[], header?: SessionHeader): Session {
    return new Session(id, seed, header)
  }

  /**
   * Restore a detached session by taking ownership of fresh persistence values.
   * The storage format, event envelopes, sequence continuity, surface transitions,
   * and header fields are validated before the restored objects are frozen.
   * @param id - restored session identity.
   * @param seed - fresh detached events whose ownership is transferred.
   * @param header - fresh detached metadata whose ownership is transferred.
   * @returns a restored detached session.
   */
  static fromRestore(id: SessionId, seed: readonly SessionEvent[], header: SessionHeader): Session {
    return new Session(id, seed, header, 'restore')
  }

  private constructor(
    id: SessionId,
    seed?: readonly SessionEvent[],
    header?: SessionHeader,
    mode: 'snapshot' | 'restore' = 'snapshot',
  ) {
    const restoredHeader = mode === 'restore'
      ? validateRestoredSessionHeader(id, header)
      : undefined
    if (seed !== undefined) {
      // Validate the seed to the SAME invariants `append` enforces, so a
      // replay/fork (`ctx.sessions.create(id, { seed })`) cannot construct a
      // live log that no persistence backend could store: each event's `data`
      // must be JSON-serializable, and `seq` must be contiguous from 0 (the
      // `seq = log.length` contract the whole system relies on). Without this,
      // a bad seed would surface only later as a backend rejection or a silent
      // divergence between the live log and disk.
      for (const [index, source] of seed.entries()) {
        // The seed is a persistence/replay boundary: validate and detach the
        // complete event in one lossless-JSON pass.
        const snapshot = mode === 'restore' ? source : snapshotJsonValue(source)
        if (snapshot === undefined) {
          throw new Error(`seed event at index ${index} is not losslessly JSON-serializable`)
        }
        assertSessionEventEnvelope(snapshot, index)
        assertCurrentLlmShape(snapshot, index)
        assertSupportedRequestHeader(snapshot.type, snapshot.data, `seed event at index ${index}`)
        if (snapshot.seq !== index) {
          throw new Error(`seed event at index ${index} has seq ${snapshot.seq} (expected ${index}); seed must be contiguous from 0`)
        }
        // A seed is accepted incrementally through the same transition as a
        // live append and a full-log fold. The candidate is planned before it
        // enters `log`, so a failure cannot partially mutate the surface.
        this.surfaceManager.validateNext(snapshot)
        this.log.push(deepFreeze(snapshot))
      }
    }
    this.firstLiveSeq = this.log.length
    this.header = restoredHeader ?? snapshotSessionHeader(id, header)
    // Appended here so the marker is already in `events` when a backend
    // captures the creation seed: no load-time write. Re-marking is skipped
    // because a cold session is resumed on first touch, so repeatedly opening
    // one must not grow its log per open.
    if (seed !== undefined && this.log.at(-1)?.type !== 'session/end-seed') {
      this.append('session/end-seed', {})
    }
  }

  /** Cached immutable public snapshot of the private append-only log. */
  private eventsSnapshot: readonly SessionEvent[] | undefined

  /**
   * An immutable snapshot of the append-only event log. The snapshot is reused
   * until the next append; a previously returned array does not grow later.
   * Events and their nested data are deep-frozen at acceptance, so neither a
   * cast nor ordinary JavaScript can rewrite durable history.
   */
  get events(): readonly SessionEvent[] {
    this.eventsSnapshot ??= Object.freeze([...this.log])
    return this.eventsSnapshot
  }

  /** The next event's sequence number — always the log length (the `seq = log.length` contiguity contract). */
  get seq(): number {
    return this.log.length
  }

  /**
   * Append one typed event to the log and synchronously notify observers via
   * the store-owned, module-private publication hooks. The hot path never blocks
   * on I/O — persistence plugins buffer asynchronously. Once the event enters
   * the log, the append is committed: observer failures are logged and
   * contained per listener, so they do not change the return value or prevent
   * later listeners from observing the same accepted event.
   *
   * @param type - The event type (key of {@link SessionEventMap}).
   * @param data - The event payload; must be JSON-serializable.
   * @param opts - Surface metadata: `surfaceOp` controls how the event enters
   *   the ordered surface; `sourceEventSeqs` lists the seq numbers of earlier
   *   events this one derives from. REQUIRED for
   *   {@link SurfaceEventType} events (every message-producing event must
   *   declare how it joins the surface, the sole source of derived model
   *   history) and
   *   rejected by the compiler for non-surface types like `turn/start` or
   *   `assistant/chunk`.
   * @returns the logged event — its assigned `seq`/`time` plus the SNAPSHOT of
   *   `data` that entered the log, so reading `event.data` back sees the logged
   *   value, never the caller's still-mutable input.
   * @throws if `data` or surface metadata is not losslessly JSON-serializable
   *   (BigInt, function, symbol, undefined, negative zero, non-finite number,
   *   circular reference, sparse array, or an exotic object such as
   *   Map/Set/Date/class instance), or when the candidate violates the
   *   canonical surface contract (marker shape and eligibility, unique
   *   earlier source-event references, positional replacement validity, and complete
   *   shadowed-node coverage). One recursive pass reads, validates, and
   *   copies each nested value once, so a stateful getter cannot supply one value
   *   to validation and another to storage. The event log is the durable source
   *   of truth, so a bad event fails at the append site rather than later during
   *   a backend flush. A synchronous internal dispatch validation failure or an
   *   append reentered while this acceptance/publication boundary is open also
   *   rejects before the log changes.
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent] : []
  ): SessionEvent<T> {
    const surfaceOpts: SurfaceIntent | undefined = opts[0]
    const surfaceMetadata = {
      ...surfaceOpts?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },
      ...surfaceOpts?.surfaceOp === undefined ? {} : { surfaceOp: surfaceOpts.surfaceOp },
    }
    const dataSnapshot = snapshotJsonValue(data)
    if (dataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable data`)
    }
    assertSupportedRequestHeader(type, dataSnapshot, `session event "${type}"`)
    const surfaceMetadataSnapshot = snapshotJsonValue(surfaceMetadata)
    if (surfaceMetadataSnapshot === undefined) {
      throw new Error(`session event "${type}" carries non-JSON-serializable surface metadata`)
    }
    const entry = attachments.get(this)
    if (entry?.appending) {
      throw new Error('session append cannot reenter while another append is being published')
    }
    const published = deepFreeze({
      type,
      seq: this.log.length,
      time: Date.now(),
      data: dataSnapshot,
      ...surfaceMetadataSnapshot,
    })
    assertPublishedSessionEvent(published, type, this.log.length)
    this.surfaceManager.validateNext(published)
    if (!isSessionEventOfType(published, type)) {
      throw new Error(`session event "${type}" failed publication narrowing`)
    }

    if (entry !== undefined) entry.appending = true
    using _publishing = {
      [Symbol.dispose]: (): void => {
        if (entry === undefined) return
        entry.appending = false
        if (entry.detachRequested && !entry.announcing) entry.detach()
      },
    }
    let callbacks: SessionCallback[] | undefined
    const callbackArgs: unknown[] = [this, published]
    if (entry !== undefined) {
      callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...callbackArgs])
    }
    this.log.push(published)
    this.eventsSnapshot = undefined
    if (callbacks !== undefined && entry !== undefined) {
      invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
    }
    return published
  }

  /** Cached fold of the request-header events — see {@link requestHeader}. */
  private headerFold: EpochHeader | undefined
  /** Log position (events consumed) the header fold has reached. */
  private headerFoldSeq = 0

  /**
   * The {@link EpochHeader} in force after the log's last header event — the
   * header the NEXT request will be compared against — or undefined before
   * the first `request/header` snapshot. The live, incrementally-maintained
   * form of `foldRequestHeader(session.events)`: each header event is folded
   * once, when first seen, so a per-step read costs O(new events).
   * @returns the folded header, or undefined when no header event exists yet.
   */
  requestHeader(): EpochHeader | undefined {
    if (this.headerFoldSeq < this.log.length) {
      // Frozen on update: the fold is session state exposed by reference — a
      // consumer mutating it in place (instead of building a replacement)
      // would desync every later comparison against the log, so mutation
      // throws instead.
      this.headerFold = deepFreeze(foldRequestHeader(this.log.slice(this.headerFoldSeq), this.headerFold))
      this.headerFoldSeq = this.log.length
    }
    return this.headerFold
  }

  /** Cached fold of `request/context` events. */
  private contextFold: RequestContext | undefined
  private contextFoldSeq = 0

  /**
   * Return the latest resolved route metadata, or `undefined` before the first
   * `request/context` event. Each event is folded once.
   * @returns the latest immutable route metadata.
   */
  requestContext(): RequestContext | undefined {
    if (this.contextFoldSeq < this.log.length) {
      for (const event of this.log.slice(this.contextFoldSeq)) {
        if (event.type === 'request/context') this.contextFold = deepFreeze({ ...event.data })
      }
      this.contextFoldSeq = this.log.length
    }
    return this.contextFold
  }

  /** The derived-message cache: frozen projections, extended per unseen node. */
  private derived: Message[] = []
  /** Surface position (nodes projected) the cache has reached. */
  private derivedNodes = 0
  /** {@link SurfaceManager.replaceGeneration} the cache was built under. */
  private derivedGeneration = 0

  /**
   * Derive the LLM message history by walking the ordered sequences of
   * message-producing events maintained by `surfaceOp` markers. The
   * surface is the single source of derived history: every message-producing
   * append records its `surfaceOp`, so a raw event with no marker (a chunk, a
   * turn boundary) is correctly absent, and a compaction `replace` deletes the
   * shadowed nodes from the derivation. The projection rules are
   * {@link deriveEventMessage}, folded per node.
   *
   * CACHED: each surface node is projected exactly once, when first seen — a
   * call costs O(new nodes), and a surface rewrite (a `replace`;
   * {@link SessionSurface.replaceGeneration}) rebuilds. The returned array is
   * a fresh snapshot per call (later appends never grow an array a caller
   * already holds); the `Message` objects in it are SHARED and **deep-frozen**.
   * Their content reuses the already frozen durable event data, so the cache
   * needs no second deep clone and consumers still cannot mutate the log.
   * @returns a fresh array of the shared, frozen derived history.
   */
  deriveMessages(): Message[] {
    const surface = this.surface
    const nodes = surface.nodes
    const generation = surface.replaceGeneration
    if (generation !== this.derivedGeneration) {
      this.derived = []
      this.derivedNodes = 0
      this.derivedGeneration = generation
    }
    for (const seq of nodes.slice(this.derivedNodes)) {
      const event = this.log[seq]
      if (event === undefined) {
        throw new Error(`surface sequence ${String(seq)} is missing from the session log`)
      }
      const msg = this.deriveEventMessage(event)
      // A surface node is one of the five message-producing types, but an
      // empty-content assistant/message (a max-tokens step that hosts only
      // usage) derives to null and must not enter the transcript.
      if (msg) this.derived.push(msg)
    }
    this.derivedNodes = nodes.length
    return [...this.derived]
  }

  /**
   * Instance face of the pure per-node `deriveEventMessage` export from
   * `surface.ts`.
   * @param event - the event to project.
   * @returns the derived message, or null when the event produces none.
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    return deriveEventMessage(event)
  }
}

/** A fork source: either the live session object or its live store id. */
export type SessionForkSource = Session | SessionId

/**
 * Rejection codes for session forking: the fork source id is unknown to the
 * live store (`SESSION_NOT_FOUND`) or names a session object that is not the
 * store's live instance (`SESSION_NOT_LIVE`); the requested child id is
 * already taken (`SESSION_ALREADY_EXISTS`); the boundary is not a contiguous
 * existing seq (`INVALID_BOUNDARY`); or the selected prefix ends inside an
 * open turn (`OPEN_TURN`).
 */
export type SessionForkErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_LIVE'
  | 'SESSION_ALREADY_EXISTS'
  | 'INVALID_BOUNDARY'
  | 'OPEN_TURN'

/** Typed error for session fork rejections. */
export class SessionForkError extends Error {
  constructor(message: string, public readonly code: SessionForkErrorCode) {
    super(message)
    this.name = 'SessionForkError'
  }
}

/**
 * In-memory session store (`ctx.sessions`).
 *
 * Persistence is intentionally not implemented here — persistence plugins
 * subscribe to `session/event` and flush on `session/flush` / dispose.
 */
export class SessionStore extends Service {
  private store = new Map<SessionId, SessionEntry>()
  private counter = 0
  /** Durable request reservations shared by exact root and actor Sessions. */
  readonly requestBudgets: SessionRequestBudgets = new SessionRequestBudgets(this)

  constructor(ctx: Context) {
    super(ctx, 'sessions')
    ctx.inject(['typert'], (typeCtx) => {
      typeCtx.typert.lookups.register('session', {
        parameter: 'session',
        wire: 'sessionId',
        hostTypeSymbol: '@deepseek-ai/dsh-session#Session',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
        resolve: sessionId => this.get(sessionId),
      })
    })
  }

  /**
   * Create a session owned by the calling fiber: disposing that fiber stops
   * event notification and removes the session from the store. `options.seed`
   * populates the session with a copy of those events (replay/fork);
   * `options.meta` attaches creation metadata (validated absolute `cwd`, seed
   * and parent lineage, and delegation depth) as the immutable
   * {@link SessionHeader} (the store fills `version`/`id`/`createdAt`).
   *
   * For an agent whose session must be torn down IN ORDER with its loop (so the
   * loop's final events are published before the store attachment ends), do NOT use this
   * — fold the session lifecycle into the agent's own effect via
   * {@link prepare} + {@link enter} + {@link announce} (see
   * `dsh-agent-loop`'s creation transaction).
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header.
   * @returns the live session, already entered and announced.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path (storage backends key directories off it).
   */
  create(id?: SessionId, options?: CreateSessionOptions): Session {
    const session = this.prepare(id, options)
    // Single effect owned by the calling fiber. Yield the detach BEFORE
    // announcing so a throwing `session/created` listener rolls the attach back
    // (the generator effect disposes already-yielded disposers on a throw)
    // instead of leaking the store entry and its publication hooks.
    this.ctx.effect(function* (this: SessionStore) {
      yield this.enter(session)
      this.announce(session)
    }.bind(this), 'sessions.create()')
    return session
  }

  /**
   * Build a session WITHOUT entering it into the store — validate the id/cwd and
   * construct the {@link Session} (with its immutable {@link SessionHeader}).
   * Pairs with {@link enter} + {@link announce}: a caller that owns a composite
   * `ctx.effect` (the agent factory) folds the session lifecycle into that ONE
   * effect so a fiber unload tears the session + agent down as a single ORDERED
   * chain rather than as racing sibling effects — which would remove the publication hooks
   * before the driver's closing events commit, dropping them.
   *
   * @param id - the session id; omitted, the store mints `session-<n>`.
   * @param options - seed events and/or creation metadata for the header. With
   *   `seedSource: 'persistence'`, metadata and events must be fresh detached
   *   graphs whose ownership transfers to this call: they are validated and
   *   frozen in place through {@link Session.fromRestore}, so the caller must
   *   retain no mutable aliases.
   * @returns the constructed session, NOT yet in the store.
   * @throws if a session with `id` already exists, metadata is not a plain
   *   lossless-JSON record with valid scalar fields, or `meta.cwd` is a
   *   non-absolute path.
   */
  prepare(id?: SessionId, options?: PrepareSessionOptions): Session {
    let sessionId: SessionId
    if (id === undefined) {
      do sessionId = SessionId(`session-${++this.counter}`)
      while (this.store.has(sessionId))
    } else {
      sessionId = SessionId(id)
    }
    if (this.store.has(sessionId)) throw new Error(`session "${sessionId}" already exists`)
    if (options?.seedSource === 'persistence') {
      return Session.fromRestore(sessionId, options.seed, options.meta)
    }
    const seed = options?.seed
    const meta = options?.meta
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: meta?.createdAt ?? Date.now(),
      ...meta?.cwd === undefined ? {} : { cwd: meta.cwd },
      ...meta?.parentSession === undefined ? {} : { parentSession: meta.parentSession },
      ...meta?.seedLength === undefined ? {} : { seedLength: meta.seedLength },
      ...meta?.origin === undefined ? {} : { origin: meta.origin },
      ...meta?.delegationDepth === undefined ? {} : { delegationDepth: meta.delegationDepth },
      ...meta?.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
    }
    return Session.create(sessionId, seed, header)
  }

  /**
   * Enter a {@link prepare}d session into the store: install the module-private
   * append publication hooks and add it to the store. Returns the DETACH
   * disposer (hooks + store removal). Does NOT emit `session/created` —
   * the caller yields this disposer inside its effect and THEN calls
   * {@link announce}, so a throwing `session/created` listener rolls the attach
   * back instead of leaking it.
   *
   * Re-checks the id for a duplicate: `prepare` and `enter` are public
   * cross-package primitives and a caller may interleave arbitrary work (or
   * another create) between them, so a stale prepared session must NOT overwrite
   * a live store entry of the same id — its detach disposer would later delete
   * the REAL session. The {@link create} convenience and the agent factory call
   * the two back-to-back so they never trip this, but the public API cannot
   * assume that.
   *
   * @param session - a {@link prepare}d session not yet in the store.
   * @returns the detach disposer (publication hooks + store removal). When called from
   *   a synchronous `session/created` listener, removal and disposal wait until
   *   that creation dispatch unwinds.
   * @throws if a session with this id is already in the store.
   */
  enter(session: Session): () => void {
    const id = session.id
    const carrier = scopeTarget(session, scopeOf(this.ctx))
    // This is the authoritative collision boundary after arbitrary unpublished
    // preparation. Only one exact same-id transaction can publish.
    if (this.store.has(id)) throw new Error(`session "${id}" already exists`)
    if (attachments.has(session)) throw new Error(`session "${id}" is already attached to a store`)
    const entry: SessionEntry = {
      id,
      session,
      carrier,
      emitCtx: this.ctx,
      announced: false,
      announcing: false,
      appending: false,
      detachRequested: false,
      detach: () => { this.detachEntered(entry) },
    }
    this.store.set(id, entry)
    attachments.set(session, entry)
    let entered = true
    const detach = (): void => {
      if (!entered) return
      entered = false
      // A lifecycle listener may own the advanced detach capability. Keep the
      // entry and its publication hooks live until synchronous creation or append
      // publication unwinds, then publish the paired disposal edge.
      if (entry.announcing || entry.appending) {
        entry.detachRequested = true
        return
      }
      entry.detach()
    }
    return detach
  }

  /** Remove one exact entered session and emit its paired disposal when announced. */
  private detachEntered(entry: SessionEntry): void {
    entry.detachRequested = false
    // A stale capability cannot remove observers or storage belonging to a
    // later same-id lifecycle.
    if (this.store.get(entry.id) !== entry) {
      throw new Error(`session "${entry.id}" detach target is not the live entry`)
    }
    this.store.delete(entry.id)
    attachments.delete(entry.session)
    if (entry.announced) this.emitDisposed(entry)
  }

  /** Emit `session/created` exactly once for an {@link enter}ed session (with
   * the carrier {@link enter} captured). Separate from {@link enter} so the
   * caller can yield the detach disposer first (rollback safety — see
   * {@link enter}).
   * @param session - the entered session to announce to listeners.
   * @throws if the session is not live or its announcement already began,
   *   including a reentrant call from a creation listener. */
  announce(session: Session): void {
    const entry = this.liveEntryFor(session)
    if (entry.announced || entry.announcing) {
      throw new Error(`session "${entry.id}" was already announced`)
    }
    // Mark before emit: Cordis emit may deliver to earlier listeners and then
    // throw. Rollback must still pair that partial creation with disposal, and
    // a listener cannot recursively create a second lifecycle edge.
    entry.announced = true
    const callbackArgs: unknown[] = [session]
    entry.announcing = true
    using _announcing = {
      [Symbol.dispose]: (): void => {
        entry.announcing = false
        if (entry.detachRequested && !entry.appending) entry.detach()
      },
    }
    const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/created', session])
    for (const callback of callbacks) {
      // Synchronous throws intentionally propagate and veto publication; the
      // yielded detach then emits the paired disposal edge. An async function
      // is nevertheless assignable to a void listener, so observe its returned
      // promise: rejection is too late to roll back and must be logged instead
      // of becoming unhandled.
      observeReturnedThenable(callback(...callbackArgs), (reason) => {
        this.ctx.logger.warn(`session "${entry.id}": session/created listener rejected: ${renderContainedFailure(reason)}`)
      })
    }
  }

  /** Emit the paired teardown notification with per-listener containment. */
  private emitDisposed(entry: SessionEntry): void {
    const callbackArgs: unknown[] = [entry.session]
    observeListenerInvocation(
      () => {
        const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/disposed', entry.session])
        invokeContainedSessionObservers(this.ctx, 'session/disposed', entry.id, callbackArgs, callbacks)
      },
      (reason) => {
        this.ctx.logger.warn(`session "${entry.id}": session/disposed dispatch threw: ${renderContainedFailure(reason)}`)
      },
      (reason) => {
        this.ctx.logger.warn(`session "${entry.id}": session/disposed dispatch rejected: ${renderContainedFailure(reason)}`)
      },
    )
  }

  /**
   * Dispatch the awaited `session/flush` durability checkpoint for `session`,
   * with the carrier captured at {@link enter}. THE flush entry point: the
   * store owns the carrier, so callers (the checkpoint policy's per-request
   * barrier, goal-round-driver's idle checkpoint, teardown drains, and consumers
   * that flush themselves before reading storage) must come through here
   * rather than dispatch a raw `ctx.parallel('session/flush', …)` — one owner,
   * one spelling, and the scoped-dispatch invariant can pin it.
   * @param session - the session whose buffered events must reach durable storage.
   * @returns whether at least one durability listener participated, after every
   *   listener has settled successfully.
   * @throws the first registered listener failure after every listener settles.
   */
  async flush(session: Session): Promise<boolean> {
    const { carrier } = this.liveEntryFor(session)
    const callbackArgs: unknown[] = [session]
    const callbacks = collectSessionCallbacks(this.ctx, [carrier, 'session/flush', session])
    const results = await Promise.allSettled(callbacks.map(async callback => await callback(...callbackArgs)))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure !== undefined) {
      if (failure.reason instanceof Error) throw failure.reason
      throw new Error('session flush listener failed')
    }
    return callbacks.length > 0
  }

  /** Return the exact live entry; detached/prepared objects reject. */
  private liveEntryFor(session: Session): SessionEntry {
    const entry = attachments.get(session)
    if (entry === undefined || this.store.get(entry.id) !== entry) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    return entry
  }

  /**
   * Look up a live session.
   * @param id - the session id to look up.
   * @returns the session, or undefined when no live session has that id.
   */
  get(id: SessionId): Session | undefined {
    return this.store.get(id)?.session
  }

  /**
   * All live sessions, in creation order.
   * @returns a fresh array; mutating it does not affect the store.
   */
  list(): Session[] {
    return [...this.store.values()].map(entry => entry.session)
  }

  /**
   * Create a live child session from a stable prefix of a live source.
   * `boundary` is an inclusive source event seq; omitted means the source's
   * current last event. The selected slice may end with a between-turn event
   * but must not end inside an open turn.
   *
   * @param source - Live source session object or id.
   * @param boundary - Inclusive source event seq to fork through; omitted means
   *   the source's current last event, and omitted on an empty source forks an
   *   empty child.
   * @param childSessionId - Optional child session id; omitted delegates to
   *   `SessionStore`'s id policy.
   * @returns The created live child session.
   */
  fork(source: SessionForkSource, boundary?: number, childSessionId?: SessionId): Session {
    if (childSessionId !== undefined && this.get(childSessionId) !== undefined) {
      throw new SessionForkError(`session "${childSessionId}" already exists`, 'SESSION_ALREADY_EXISTS')
    }
    const liveSource = this._resolveForkSource(source)
    const seed = this._forkSeed(liveSource, boundary)
    return this.create(childSessionId, {
      seed,
      meta: {
        ...liveSource.header.cwd !== undefined ? { cwd: liveSource.header.cwd } : {},
        parentSession: liveSource.id,
        seedLength: seed.length,
      },
    })
  }

  private _forkSeed(session: Session, requestedBoundary: number | undefined): SessionEvent[] {
    const events = session.events
    const lastEvent = events.at(-1)
    let boundary: number
    if (requestedBoundary !== undefined) {
      boundary = requestedBoundary
    } else {
      if (lastEvent === undefined) return []
      boundary = lastEvent.seq
    }
    if (!Number.isSafeInteger(boundary) || boundary < 0) {
      throw new SessionForkError(
        `fork boundary for session "${session.id}" must be a non-negative safe integer, got ${String(boundary)}`,
        'INVALID_BOUNDARY',
      )
    }
    if (boundary >= events.length) {
      const lastSeq = events.at(-1)?.seq
      throw new SessionForkError(
        `fork boundary ${boundary} does not exist in session "${session.id}" (last seq: ${lastSeq ?? 'none'})`,
        'INVALID_BOUNDARY',
      )
    }

    const boundaryEvent = events[boundary]
    if (boundaryEvent === undefined || boundaryEvent.seq !== boundary) {
      throw new SessionForkError(
        `fork boundary ${boundary} does not match a contiguous event seq in session "${session.id}"`,
        'INVALID_BOUNDARY',
      )
    }
    const lastTurnBoundary = events.slice(0, boundary + 1)
      .findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (lastTurnBoundary?.type === 'turn/start') {
      throw new SessionForkError(
        `fork boundary ${boundary} in session "${session.id}" ends inside open turn ${lastTurnBoundary.data.turn}`,
        'OPEN_TURN',
      )
    }

    return events.slice(0, boundary + 1)
  }

  private _resolveForkSource(source: SessionForkSource): Session {
    if (typeof source === 'string') {
      const session = this.get(source)
      if (session === undefined) throw new SessionForkError(`session "${source}" not found`, 'SESSION_NOT_FOUND')
      return session
    }

    const live = this.get(source.id)
    if (live === undefined) {
      throw new SessionForkError(`session "${source.id}" not found`, 'SESSION_NOT_FOUND')
    }
    if (live !== source) throw new SessionForkError(`session "${source.id}" is not the live store instance`, 'SESSION_NOT_LIVE')
    return source
  }

}

export { decodeSeqRanges, encodeSeqRanges } from './seq-ranges.ts'
export default SessionStore
