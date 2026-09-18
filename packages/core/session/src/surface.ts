/**
 * Surface layer on top of the session event log: an ordered view of events
 * that produce LLM messages. The append-only log remains the source of truth.
 *
 * Browser-safe: web clients consume this subpath export, so it must stay free
 * of `node:` imports (they break the vite bundle).
 *
 * @module @deepseek-ai/dsh-session/surface
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SurfaceEvent, SurfaceOp } from './types.ts'

/** Runtime counterpart of the message-producing event union. */
const SURFACE_EVENT_TYPES = new Set<string>([
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Whether an event type can join the model-visible surface.
 * @param type - event type to test.
 * @returns true for one of the three message-producing event types.
 */
export function isSurfaceEligibleType(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/**
 * Narrow an event to a surface-eligible event carrying its required marker.
 * @param event - event to test.
 * @returns true when both the type and marker identify a surface event.
 */
export function isSurfaceEvent(event: SessionEvent): event is SurfaceEvent {
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
    case 'tool/result':
      return event.surfaceOp !== undefined
    default:
      return false
  }
}

/**
 * Narrow an event to an append-origin surface event: one that entered the
 * surface at its own log position and was never itself a replacement copy.
 *
 * The model-visible surface deliberately shadows replaced ranges, so it is the
 * wrong source for a human transcript — a landed replacement would erase
 * conversation the user already saw. Append-origin events are that transcript's
 * durable source material; replacement copies stay model-only.
 * @param event - event to test.
 * @returns true when the event appended to the surface tail.
 */
export function isAppendSurfaceEvent(
  event: SessionEvent,
): event is SurfaceEvent & { surfaceOp: 'append' } {
  return isSurfaceEvent(event) && event.surfaceOp === 'append'
}

/**
 * Narrow an event to a surface replacement: a node that shadowed an existing
 * surface range instead of appending to the tail. The counterpart of
 * {@link isAppendSurfaceEvent} over the two {@link SurfaceOp} variants.
 * @param event - event to test.
 * @returns true when the event replaced a surface range.
 */
export function isReplacementSurfaceEvent(
  event: SessionEvent,
): event is SurfaceEvent & { surfaceOp: Extract<SurfaceOp, { op: 'replace' }> } {
  return isSurfaceEvent(event) && event.surfaceOp !== 'append'
}

/**
 * Project a single event into the LLM message it derives to, or null when it
 * produces none — a non-surface event (chunk, boundary, log-only record) or an
 * empty-content assistant/message (which exists only to host usage). This is
 * THE per-node projection rule: `Session.deriveMessages` folds it over the
 * live surface, external reconstructors and pure projections fold the same
 * function over a log prefix's surface to rebuild the exact messages any
 * request was built from. The returned message is the already frozen message
 * nested in the event wrapper and shared by delivery, durable history, and
 * model requests.
 * @param event - the event to project.
 * @returns the derived message, or null when the event produces none.
 */
export function deriveEventMessage(event: SessionEvent): Message | null {
  // Intentionally non-exhaustive: only message-producing events derive
  // history; turn/step boundaries, chunks, usage, and errors are trace/replay
  // data.
  switch (event.type) {
    // Ordinary prompts and injected context project in user role: the event's
    // model-facing content stays verbatim. Do NOT re-add per-type framing
    // (e.g. `<context>`) here: framing is caller-owned — a producer bakes it
    // into `content`, as agent-instructions does with `<system-reminder>` — or,
    // if reintroduced, must be driven by the event `meta` map and a dedicated
    // renderer, keeping this projection a verbatim pass-through. See the
    // deferred design note in
    // ../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md
    case 'user/message': {
      return event.data
    }
    case 'assistant/message': {
      // Skip an empty-content assistant/message: it exists only to host a
      // max-tokens step's usage and must not inject a content-less assistant
      // turn into the provider transcript.
      if (event.data.message.content.length === 0) return null
      return event.data.message
    }
    case 'tool/result': {
      return event.data.message
    }
    default:
      // A non-surface event (boundary, chunk, log-only record) projects to
      // no message. Merge-extensible union: no assertNever here.
      return null
  }
}

/** One replacement operation observed while folding a session surface. */
export interface SurfaceFoldReplacement {
  /** Seq of the event that replaced the prior surface range. */
  seq: number
  /** Declared inclusive start seq of the replaced surface range. */
  start: number
  /** Declared inclusive end seq of the replaced surface range. */
  end: number
  /** Actual surface entries removed by the operation, in surface order. */
  shadowedSeqs: number[]
}

/** Complete result of replaying the surface operations in a session log. */
export interface SurfaceFoldResult {
  /** Current surface event sequences in model-visible order. */
  nodes: number[]
  /** Replacement operations in event order. */
  replacements: SurfaceFoldReplacement[]
}

/** Readonly live projection of the message-producing session events. */
export interface SessionSurface {
  /** Current surface event sequences in model-visible order. */
  readonly nodes: readonly number[]
  /** Monotonic count of committed positional replacements. */
  readonly replaceGeneration: number
}

/** Mutable state shared by complete and incremental folds. */
interface SurfaceFoldState {
  nodes: number[]
  replaceGeneration: number
}

/** A validated replacement transition that has not mutated fold state yet. */
interface SurfaceReplacePlan extends SurfaceFoldReplacement {
  kind: 'replace'
  startIdx: number
  endIdx: number
}

/** One validated surface transition that has not mutated fold state yet. */
type SurfacePlan =
  | { kind: 'append'; seq: number }
  | SurfaceReplacePlan

/** Create an empty surface fold state. */
function createFoldState(): SurfaceFoldState {
  return { nodes: [], replaceGeneration: 0 }
}

/** Reject a surface-contract violation; must not return. */
export type SurfaceContractReject = (message: string) => never

function throwSurfaceContract(message: string): never {
  throw new Error(message)
}

/** Whether a runtime value is a non-negative safe event sequence. */
function isEventSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Whether a runtime value is the exact positional-replacement shape. */
function isReplaceOp(value: object): value is Extract<SurfaceOp, { op: 'replace' }> {
  if (!Object.hasOwn(value, 'op') || !Object.hasOwn(value, 'start') || !Object.hasOwn(value, 'end')) {
    return false
  }
  if (Object.keys(value).length !== 3) return false
  if (!('op' in value) || !('start' in value) || !('end' in value)) return false
  return value.op === 'replace' && isEventSeq(value.start) && isEventSeq(value.end)
}

/** Validate event-local surface eligibility and return its operation. */
function surfaceOpOf(event: SessionEvent, reject: SurfaceContractReject): SurfaceOp | undefined {
  switch (event.type) {
    case 'user/message':
    case 'assistant/message':
    case 'tool/result': {
      const { surfaceOp } = event
      if (surfaceOp === undefined) {
        reject(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
      }
      if (surfaceOp === 'append') return surfaceOp
      if (typeof surfaceOp !== 'object' || Array.isArray(surfaceOp)) {
        reject(`session event "${event.type}" carries an invalid surfaceOp`)
      }
      if (!isReplaceOp(surfaceOp)) {
        reject(`session event "${event.type}" carries an invalid replace surfaceOp`)
      }
      return surfaceOp
    }
    default: {
      if ('surfaceOp' in event) {
        reject(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`)
      }
      if ('sourceEventSeqs' in event) {
        reject(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`)
      }
      return
    }
  }
}

/** Validate cited source-event seqs against prior log entries and the replacement range. */
function assertProvenance(
  event: SessionEvent,
  shadowedSeqs: readonly number[],
  reject: SurfaceContractReject,
): void {
  const raw = 'sourceEventSeqs' in event ? event.sourceEventSeqs : undefined
  const sources = new Set<number>()
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      reject(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`)
    }
    if (raw.length === 0 && event.type !== 'assistant/message') {
      reject('sourceEventSeqs must not be empty except on assistant/message')
    }
    let nonEarlierSource: number | undefined
    for (const source of raw) {
      if (!isEventSeq(source)) {
        reject(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`)
      }
      sources.add(source)
      if (nonEarlierSource === undefined && source >= event.seq) nonEarlierSource = source
    }
    if (sources.size !== raw.length) {
      reject('sourceEventSeqs must not contain duplicates')
    }
    if (nonEarlierSource !== undefined) {
      reject(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`)
    }
  }
  const missing = shadowedSeqs.filter(seq => !sources.has(seq))
  if (missing.length > 0) {
    reject(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`)
  }
}

/** Locate one replacement range without mutating the current fold state. */
function replacementRange(
  state: SurfaceFoldState,
  op: Extract<SurfaceOp, { op: 'replace' }>,
  reject: SurfaceContractReject,
): Pick<SurfaceReplacePlan, 'startIdx' | 'endIdx' | 'shadowedSeqs'> {
  const startIdx = state.nodes.indexOf(op.start)
  if (startIdx === -1) {
    reject(`surface replace: start seq ${op.start} not found in surface`)
  }
  const endIdx = state.nodes.indexOf(op.end)
  if (endIdx === -1) {
    reject(`surface replace: end seq ${op.end} not found in surface`)
  }
  if (startIdx > endIdx) {
    reject(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`)
  }
  return {
    startIdx,
    endIdx,
    shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1),
  }
}

/**
 * Deep structural equality over the session-event JSON value domain
 * (null/boolean/number/string, arrays, plain objects). Replaces
 * `node:util`'s isDeepStrictEqual to keep this module browser-safe.
 */
function isDeepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => isDeepEqualJson(item, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  const left: Record<string, unknown> = { ...a as Record<string, unknown> }
  const right: Record<string, unknown> = { ...b as Record<string, unknown> }
  return aKeys.every(key => Object.hasOwn(b, key) && isDeepEqualJson(left[key], right[key]))
}

/** Restrict a tool-result replacement to one current result's content. */
function assertToolResultRewrite(
  event: SessionEvent,
  shadowedSeqs: readonly number[],
  events: readonly SessionEvent[],
  baseSeq: number,
  reject: SurfaceContractReject,
): void {
  if (event.type !== 'tool/result') return
  if (shadowedSeqs.length !== 1) {
    reject('tool/result surface replacement must rewrite exactly one current node')
  }
  for (const originalSeq of shadowedSeqs) {
    const original = events[originalSeq - baseSeq]
    if (original?.type !== 'tool/result') {
      reject('tool/result surface replacement must target a current tool/result')
    }
    const originalRest: Record<string, unknown> = { ...original.data }
    const replacementRest: Record<string, unknown> = { ...event.data }
    const originalResult = original.data.message.content[0]
    const replacementResult = event.data.message.content[0]
    originalRest['message'] = {
      ...original.data.message,
      content: [{ ...originalResult, content: null }],
    }
    replacementRest['message'] = {
      ...event.data.message,
      content: [{ ...replacementResult, content: null }],
    }
    if (!isDeepEqualJson(originalRest, replacementRest)) {
      reject('tool/result surface replacement may change only content')
    }
  }
}

/** Validate one event at its replay boundary and prepare its atomic fold transition. */
function planSurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: number,
  events: readonly SessionEvent[],
  baseSeq: number,
  reject: SurfaceContractReject,
): SurfacePlan | undefined {
  if (event.seq !== expectedSeq) {
    reject(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`)
  }
  const surfaceOp = surfaceOpOf(event, reject)
  if (surfaceOp === undefined) return
  if (surfaceOp === 'append') {
    assertProvenance(event, [], reject)
    return { kind: 'append', seq: event.seq }
  }
  const range = replacementRange(state, surfaceOp, reject)
  assertProvenance(event, range.shadowedSeqs, reject)
  assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq, reject)
  return {
    kind: 'replace',
    seq: event.seq,
    start: surfaceOp.start,
    end: surfaceOp.end,
    ...range,
  }
}

/** Apply one event and return replacement metadata only when one occurred. */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
  expectedSeq: number,
  events: readonly SessionEvent[],
  baseSeq: number,
  reject: SurfaceContractReject,
): SurfaceFoldReplacement | undefined {
  const plan = planSurfaceEvent(state, event, expectedSeq, events, baseSeq, reject)
  return applySurfacePlan(state, plan)
}

/** Commit one previously validated surface transition. */
function applySurfacePlan(
  state: SurfaceFoldState,
  plan: SurfacePlan | undefined,
): SurfaceFoldReplacement | undefined {
  if (plan?.kind === 'append') {
    state.nodes.push(plan.seq)
  } else if (plan?.kind === 'replace') {
    state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq)
    state.replaceGeneration += 1
  }
  if (plan?.kind !== 'replace') return
  return {
    seq: plan.seq,
    start: plan.start,
    end: plan.end,
    shadowedSeqs: plan.shadowedSeqs,
  }
}

/**
 * Replay a complete session log through the canonical surface fold.
 * @param events - session events in contiguous seq order.
 * @param reject - contract-violation terminator; defaults to throwing `Error`.
 * @returns detached current sequences and replacement history.
 * @throws when an event violates surface metadata, source-event references, range, or tool-result rewrite rules.
 */
export function foldSurface(
  events: readonly SessionEvent[],
  reject: SurfaceContractReject = throwSurfaceContract,
): SurfaceFoldResult {
  const state = createFoldState()
  const replacements: SurfaceFoldReplacement[] = []
  for (const [index, event] of events.entries()) {
    const replacement = applySurfaceEvent(state, event, index, events, 0, reject)
    if (replacement !== undefined) replacements.push(replacement)
  }
  return { nodes: [...state.nodes], replacements }
}

/** Incremental ordered surface view and append-boundary validator. */
export class SurfaceManager implements SessionSurface {
  /** Shared transition state; replacement history is not retained. */
  private _state = createFoldState()
  /** Last processed absolute seq. */
  private _lastProcessedSeq: number
  /** Candidate already validated by `validateNext`, pending exact log admission. */
  private _pendingPlan: { event: SessionEvent; expectedSeq: number; plan: SurfacePlan | undefined } | undefined

  /**
   * @param log - Contiguous complete log or loaded event window.
   * @param baseSeq - Absolute sequence of the window's first event.
   */
  constructor(
    private log: readonly SessionEvent[],
    private readonly baseSeq = 0,
  ) {
    this._lastProcessedSeq = baseSeq - 1
  }

  /**
   * Validate the next candidate without mutating the committed surface.
   * @param event - candidate event that has not entered the log yet.
   */
  validateNext(event: SessionEvent): void {
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    const expectedSeq = this.baseSeq + this.log.length
    this._pendingPlan = {
      event,
      expectedSeq,
      plan: planSurfaceEvent(this._state, event, expectedSeq, this.log, this.baseSeq, throwSurfaceContract),
    }
  }

  /** Monotonic count of folded positional replacements. */
  get replaceGeneration(): number {
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.replaceGeneration
  }

  /** Surface event sequences in model-visible order. */
  get nodes(): readonly number[] {
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.nodes
  }

  /** Fold events appended since the previous access. */
  private _processDelta(): void {
    const tailSeq = this.baseSeq + this.log.length - 1
    for (let seq = this._lastProcessedSeq + 1; seq <= tailSeq; seq++) {
      const index = seq - this.baseSeq
      const event = this.log[index]
      if (event === undefined) {
        throw new Error(`session surface log missing event at index ${index}`)
      }
      const pending = this._pendingPlan
      if (pending?.event === event && pending.expectedSeq === seq) {
        applySurfacePlan(this._state, pending.plan)
      } else {
        applySurfaceEvent(this._state, event, seq, this.log, this.baseSeq, throwSurfaceContract)
      }
      if (pending !== undefined && pending.expectedSeq <= seq) this._pendingPlan = undefined
      this._lastProcessedSeq = seq
    }
  }
}
