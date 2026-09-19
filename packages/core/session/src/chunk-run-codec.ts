/**
 * The packed chunk-run encoding itself: the row vocabulary, the whitelist that
 * decides which `assistant/chunk` events may pack, and the lossless transforms
 * between a run of events and one row.
 *
 * Providers stream token-sized deltas, so a log stores hundreds of
 * near-identical event lines whose JSON envelopes dwarf their payloads (~56×
 * measured on a real DeepSeek session). Packing a run of consecutive same-block
 * delta chunks into ONE row removes that overhead, and expanding a row returns
 * the exact original events.
 *
 * Packed rows are an encoding vocabulary, NOT session events: they never enter
 * `Session.events`, have no `SessionEventMap` entry, and use bare (slash-less)
 * type tags so a reader cannot confuse them with the event taxonomy
 * (precedent: the JSONL header line's `session` tag).
 *
 * Every durable format that packs chunk runs writes THIS encoding: the
 * `dsh-session` JSONL log and the schema-19 SQLite store both produce and
 * accept the same rows, and a change here changes both stored formats at once.
 * What a format still owns is how many members one of its rows may carry, how
 * large the serialized row may be, and how a run that exceeds those limits is
 * split — none of which this module decides. It stays free of Node built-ins
 * so the Client face can decode a transported row.
 *
 * The encoder whitelists exact shapes — anything it does not fully recognize
 * stays verbatim, so unknown fields or future chunk variants lose compression,
 * never data. The decoder validates before expanding and fails loud on a
 * malformed row-tagged value instead of silently dropping a whole run.
 *
 * @module @deepseek-ai/dsh-session/chunk-run-codec
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from './types.ts'

/** The chunk kinds that may pack; block boundaries, usage, and finish chunks always stay one event per line. */
export type DeltaChunkKind = 'text-delta' | 'reasoning-delta' | 'tool-call-delta'

/** A run member: an `assistant/chunk` event whose exact shape the encoder whitelisted. */
export type DeltaChunkEvent = SessionEvent<'assistant/chunk'>

/**
 * Fields shared by every packed run: placement, block correlation, and member
 * timestamps as gaps. Member `k` reconstructs as seq `seq0 + k` and time
 * `time0` plus the first `k` gaps; a gap may be negative when the wall clock
 * stepped backwards between events.
 */
interface RunDataBase {
  turn: number
  step: number
  /** The stream block index every member shares. */
  index: number
  /** Epoch-ms gaps between consecutive members; length is one less than the member count. */
  dt: number[]
}

/** Payload of a `text-chunks`/`reasoning-chunks` row: one entry per member, never joined — token boundaries are data. */
interface TextRunData extends RunDataBase {
  texts: string[]
}

/** Payload of a `tool-call-chunks` row: the run-constant call identity plus each member's raw arguments fragment. */
interface ToolCallRunData extends RunDataBase {
  id: ToolCallId
  /** Present iff every member carried it, with one uniform value (a mixed run never packs). */
  name?: string
  args: string[]
}

/**
 * A packed run of consecutive delta chunk events, discriminated on `type`.
 * `seq0`/`time0` anchor the first member; text and reasoning rows share the
 * {@link TextRunData} payload, tool-call rows carry {@link ToolCallRunData}.
 */
export type ChunkRow =
  | { type: 'text-chunks'; seq0: number; time0: number; data: TextRunData }
  | { type: 'reasoning-chunks'; seq0: number; time0: number; data: TextRunData }
  | { type: 'tool-call-chunks'; seq0: number; time0: number; data: ToolCallRunData }

/** One durable record: a session event verbatim, or a packed chunk row. */
export type StorageRecord = SessionEvent | ChunkRow

/** Which member array a row tag carries. */
type PayloadKey = 'texts' | 'args'

/**
 * Test whether an encoded record is a packed chunk row rather than a Session event.
 * @param record - one persistence or bounded-history encoding record.
 * @returns Whether the record is a packed chunk row.
 */
export function isChunkRow(record: StorageRecord): record is ChunkRow {
  return record.type === 'text-chunks'
    || record.type === 'reasoning-chunks'
    || record.type === 'tool-call-chunks'
}

/**
 * Number of logical Session events represented by one packed row.
 * @param row - validated or encoder-produced packed row.
 * @returns Count of consecutive chunk events in the row.
 */
export function chunkRowLength(row: ChunkRow): number {
  return row.type === 'tool-call-chunks' ? row.data.args.length : row.data.texts.length
}

/** Whether a parsed value is a non-null object, the precondition every key and field check below assumes. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Exact-key check: `value` has every key in `keys` and nothing else. */
function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/**
 * Classify an event for packing: its delta kind when the ENTIRE shape
 * (envelope, data, chunk — exact keys, primitive types, integer seq/time) is
 * whitelisted, else `undefined` (store verbatim). Inputs come from live typed
 * appends AND parsed fixture files, so the checks are structural, not
 * type-trusted. Integer times keep gap encoding exact: a fractional time would
 * reconstruct through float subtraction/addition, which need not round-trip.
 */
function classifyDeltaChunk(event: DeltaChunkEvent): DeltaChunkKind | undefined {
  if (!hasExactKeys(event, ['type', 'seq', 'time', 'data'])) return undefined
  if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.time)) return undefined
  const data: unknown = event.data
  if (!isRecord(data) || !hasExactKeys(data, ['turn', 'step', 'chunk'])) return undefined
  if (typeof data.turn !== 'number' || typeof data.step !== 'number') return undefined
  const chunk = data.chunk
  if (!isRecord(chunk) || typeof chunk.index !== 'number') return undefined
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return hasExactKeys(chunk, ['type', 'index', 'text']) && typeof chunk.text === 'string'
        ? chunk.type
        : undefined
    case 'tool-call-delta': {
      const shapeOk = hasExactKeys(chunk, ['type', 'index', 'id', 'argumentsDelta'])
        || (hasExactKeys(chunk, ['type', 'index', 'id', 'name', 'argumentsDelta']) && typeof chunk.name === 'string')
      return shapeOk && typeof chunk.id === 'string' && typeof chunk.argumentsDelta === 'string'
        ? chunk.type
        : undefined
    }
    // Whitelist fall-through over parsed data: block-start/end, usage, finish,
    // and any future chunk variant stay one event per line.
    default:
      return undefined
  }
}

/** Classify a live or parsed event only when it is a whitelisted assistant delta chunk. */
function classifiedDeltaChunk(event: SessionEvent): { kind: DeltaChunkKind; event: DeltaChunkEvent } | undefined {
  if (event.type !== 'assistant/chunk') return undefined
  const kind = classifyDeltaChunk(event)
  if (kind === undefined) return undefined
  return { kind, event }
}

/** The tool-call fields of a whitelisted delta chunk (only after {@link classifyDeltaChunk} returned `'tool-call-delta'`). */
function toolCallOf(event: DeltaChunkEvent): { id: string; name?: string } {
  const chunk = event.data.chunk
  if (chunk.type !== 'tool-call-delta') {
    throw new TypeError('toolCallOf requires a tool-call-delta chunk')
  }
  if (typeof chunk.name === 'string') return { id: chunk.id, name: chunk.name }
  return { id: chunk.id }
}

/** The block index of a whitelisted delta chunk (not every {@link StreamChunk} variant carries one). */
function indexOf(event: DeltaChunkEvent): number {
  const chunk = event.data.chunk
  if (chunk.type === 'usage' || chunk.type === 'finish') {
    throw new TypeError('classified delta chunk is missing a numeric index')
  }
  return chunk.index
}

/** The text payload of a whitelisted text or reasoning delta. */
function textOf(event: DeltaChunkEvent): string {
  const chunk = event.data.chunk
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') {
    throw new TypeError('text run member is not a text or reasoning delta')
  }
  return chunk.text
}

/** The arguments fragment of a whitelisted tool-call delta. */
function argumentsDeltaOf(event: DeltaChunkEvent): string {
  const chunk = event.data.chunk
  if (chunk.type !== 'tool-call-delta') {
    throw new TypeError('tool-call run member is not a tool-call-delta')
  }
  return chunk.argumentsDelta
}

/** Whether `next` extends a run ending in `previous`; the caller already matched the run's kind. */
function chunkRunContinues(
  previous: DeltaChunkEvent,
  next: DeltaChunkEvent,
  kind: DeltaChunkKind,
): boolean {
  if (next.seq !== previous.seq + 1) return false
  // Two safe-integer times can sit further apart than a double subtracts
  // exactly (2^53-1 and its negation differ by ~2^54); a rounded gap would
  // decode to a different timestamp. The check is exact in both directions: a
  // true gap within safe range subtracts without rounding and passes, while a
  // true gap beyond it rounds to a value that is itself beyond and fails.
  if (!Number.isSafeInteger(next.time - previous.time)) return false
  if (next.data.turn !== previous.data.turn || next.data.step !== previous.data.step) return false
  if (indexOf(next) !== indexOf(previous)) return false
  if (kind !== 'tool-call-delta') return true
  const left = toolCallOf(previous)
  const right = toolCallOf(next)
  // `name` must match in presence AND value — a mixed run is not representable.
  return left.id === right.id
    && Object.hasOwn(left, 'name') === Object.hasOwn(right, 'name')
    && left.name === right.name
}

/**
 * Build the row for one uniform run.
 * @param kind - the run's delta kind.
 * @param run - members in log order, each extending the previous per {@link chunkRunContinues}.
 * @returns the packed row representing exactly those events.
 */
export function buildChunkRow(kind: DeltaChunkKind, run: readonly DeltaChunkEvent[]): ChunkRow {
  const first = run[0]
  if (first === undefined) {
    throw new TypeError('buildChunkRow requires a non-empty run')
  }
  const dt: number[] = []
  for (let index = 1; index < run.length; index++) {
    const event = run.at(index)
    const previous = run.at(index - 1)
    if (event === undefined || previous === undefined) {
      throw new TypeError('chunk run members are contiguous')
    }
    dt.push(event.time - previous.time)
  }
  const base = {
    turn: first.data.turn,
    step: first.data.step,
    index: indexOf(first),
    dt,
  }
  const envelope = { seq0: first.seq, time0: first.time }
  if (kind === 'tool-call-delta') {
    const call = toolCallOf(first)
    return {
      type: 'tool-call-chunks',
      ...envelope,
      data: {
        ...base,
        id: ToolCallId(call.id),
        ...call.name === undefined ? {} : { name: call.name },
        args: run.map(argumentsDeltaOf),
      },
    }
  }
  const data = { ...base, texts: run.map(textOf) }
  return kind === 'text-delta'
    ? { type: 'text-chunks', ...envelope, data }
    : { type: 'reasoning-chunks', ...envelope, data }
}

/**
 * Scan an event batch into runs and hand each complete run to the format's
 * emitter; every other event passes through verbatim, in order. Pure and
 * stateless — safe over any array, including a batch whose runs were split by
 * flush boundaries (the split runs simply pack per batch).
 *
 * @param events - the batch to encode, in log order.
 * @param emitRun - append one complete uniform run's records, packed or verbatim.
 * @returns the records to store, in order.
 */
export function scanChunkRuns(
  events: readonly SessionEvent[],
  emitRun: (out: StorageRecord[], kind: DeltaChunkKind, run: readonly DeltaChunkEvent[]) => void,
): StorageRecord[] {
  const out: StorageRecord[] = []
  let kind: DeltaChunkKind | undefined
  let run: DeltaChunkEvent[] = []
  const flush = (): void => {
    if (kind === undefined) out.push(...run)
    else emitRun(out, kind, run)
    kind = undefined
    run = []
  }
  for (const event of events) {
    const classified = classifiedDeltaChunk(event)
    if (classified === undefined) {
      flush()
      out.push(event)
      continue
    }
    const previous = run.at(-1)
    if (classified.kind === kind && previous !== undefined && chunkRunContinues(previous, classified.event, classified.kind)) {
      run.push(classified.event)
      continue
    }
    flush()
    kind = classified.kind
    run = [classified.event]
  }
  flush()
  return out
}

/**
 * Throw the uniform malformed-row diagnostic.
 * @param tag - the row tag the value claimed.
 * @param reason - what the value violated.
 * @returns never; always throws.
 */
export function malformedChunkRow(tag: string, reason: string): never {
  throw new Error(`malformed ${tag} storage row: ${reason}`)
}

/** Validate the envelope and the key set the row's data carries. */
function validateEnvelope(
  value: Record<string, unknown>,
  tag: ChunkRow['type'],
): { data: Record<string, unknown>; payloadKey: PayloadKey } {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) {
    malformedChunkRow(tag, 'envelope must be exactly {type, seq0, time0, data}')
  }
  const seq0 = value.seq0
  const time0 = value.time0
  if (typeof seq0 !== 'number' || !Number.isSafeInteger(seq0) || seq0 < 0) {
    malformedChunkRow(tag, 'seq0 must be a non-negative safe integer')
  }
  if (typeof time0 !== 'number' || !Number.isSafeInteger(time0)) {
    malformedChunkRow(tag, 'time0 must be a safe integer')
  }
  const data = value.data
  if (!isRecord(data)) malformedChunkRow(tag, 'data must be an object')
  if (tag !== 'tool-call-chunks') {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) {
      malformedChunkRow(tag, 'data must be exactly {turn, step, index, dt, texts}')
    }
    return { data, payloadKey: 'texts' }
  }
  const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args'])
  if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) {
    malformedChunkRow(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}')
  }
  if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) {
    malformedChunkRow(tag, 'id (and name when present) must be strings')
  }
  return { data, payloadKey: 'args' }
}

/** Validate placement numbers, the member array, and one gap per member boundary. */
function validateRunData(
  tag: string,
  data: Record<string, unknown>,
  payloadKey: PayloadKey,
): string[] {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    malformedChunkRow(tag, 'turn/step/index must be numbers')
  }
  const payload = data[payloadKey]
  if (!Array.isArray(payload) || payload.length === 0) {
    malformedChunkRow(tag, `${payloadKey} must be a non-empty string array`)
  }
  const members: string[] = []
  for (const member of payload) {
    if (typeof member !== 'string') {
      malformedChunkRow(tag, `${payloadKey} must be a non-empty string array`)
    }
    members.push(member)
  }
  const gaps = data.dt
  if (!Array.isArray(gaps)) {
    malformedChunkRow(tag, 'dt must be an array of safe integers')
  }
  const dt: number[] = []
  for (const gap of gaps) {
    if (typeof gap !== 'number' || !Number.isSafeInteger(gap)) {
      malformedChunkRow(tag, 'dt must be an array of safe integers')
    }
    dt.push(gap)
  }
  if (dt.length !== members.length - 1) {
    malformedChunkRow(tag, `dt length ${String(dt.length)} does not match ${String(members.length)} members`)
  }
  return members
}

/**
 * Reject a row whose members would not reconstruct exactly.
 *
 * The encoder only packs runs whose member seqs and times are all safe
 * integers, so a running value that leaves safe range is outside any encoder's
 * image: float arithmetic would round it to a different number than exact
 * arithmetic, a silent corruption. Within safe range every step is exact, so
 * the first departure is always caught.
 */
function assertReconstructs(
  tag: string,
  value: Record<string, unknown>,
  data: Record<string, unknown>,
  memberCount: number,
): void {
  const seq0 = value.seq0
  const time0 = value.time0
  if (typeof seq0 !== 'number' || typeof time0 !== 'number') {
    malformedChunkRow(tag, 'seq0 and time0 must be numbers')
  }
  if (memberCount - 1 > Number.MAX_SAFE_INTEGER - seq0) {
    malformedChunkRow(tag, 'member seqs must stay safe integers')
  }
  const gaps = data.dt
  if (!Array.isArray(gaps)) {
    malformedChunkRow(tag, 'dt must be an array of safe integers')
  }
  let time = time0
  for (const gap of gaps) {
    if (typeof gap !== 'number') {
      malformedChunkRow(tag, 'dt must be an array of safe integers')
    }
    time += gap
    if (!Number.isSafeInteger(time)) malformedChunkRow(tag, 'member times must stay safe integers')
  }
}

/** One row's validated data record, member-array key, and members. */
export interface ChunkRowShape {
  /** The row's validated data record. */
  readonly data: Record<string, unknown>
  /** Which member array the row tag carries. */
  readonly payloadKey: PayloadKey
  /** The row's members, in order. */
  readonly payload: string[]
}

/**
 * Validate everything about a row-tagged parsed value that no storage format
 * may relax: envelope fields, the data key set, placement numbers, a non-empty
 * string member array with one time gap per boundary, and exact seq/time
 * reconstruction. A format's own member-count and byte limits are its caller's.
 * @param value - one parsed row-tagged value.
 * @param tag - the row tag the value claimed.
 * @returns the validated data record, member-array key, and members.
 * @throws when the value is not a row this encoding could have produced.
 */
export function validateChunkRowShape(
  value: Record<string, unknown>,
  tag: ChunkRow['type'],
): ChunkRowShape {
  const { data, payloadKey } = validateEnvelope(value, tag)
  const payload = validateRunData(tag, data, payloadKey)
  assertReconstructs(tag, value, data, payload.length)
  return { data, payloadKey, payload }
}

/**
 * Build a {@link ChunkRow} from a value that already passed
 * {@link validateChunkRowShape}. Copies the validated fields; does not reuse
 * the parsed object as a typed row.
 * @param value - the parsed row-tagged object.
 * @param tag - the row tag the value claimed.
 * @param shape - the validated payload from {@link validateChunkRowShape}.
 * @returns the constructed packed row.
 */
export function materializeChunkRow(
  value: Record<string, unknown>,
  tag: ChunkRow['type'],
  shape: ChunkRowShape,
): ChunkRow {
  const seq0 = value.seq0
  const time0 = value.time0
  const turn = shape.data.turn
  const step = shape.data.step
  const index = shape.data.index
  const gaps = shape.data.dt
  if (typeof seq0 !== 'number' || typeof time0 !== 'number') {
    malformedChunkRow(tag, 'seq0 and time0 must be numbers')
  }
  if (typeof turn !== 'number' || typeof step !== 'number' || typeof index !== 'number') {
    malformedChunkRow(tag, 'turn/step/index must be numbers')
  }
  if (!Array.isArray(gaps)) {
    malformedChunkRow(tag, 'dt must be an array of safe integers')
  }
  const dt: number[] = []
  for (const gap of gaps) {
    if (typeof gap !== 'number') {
      malformedChunkRow(tag, 'dt must be an array of safe integers')
    }
    dt.push(gap)
  }
  if (tag === 'tool-call-chunks') {
    const id = shape.data.id
    if (typeof id !== 'string') {
      malformedChunkRow(tag, 'id must be a string')
    }
    const data: ToolCallRunData = {
      turn, step, index, dt, id: ToolCallId(id), args: shape.payload,
    }
    if (Object.hasOwn(shape.data, 'name')) {
      const name = shape.data.name
      if (typeof name !== 'string') {
        malformedChunkRow(tag, 'name must be a string')
      }
      data.name = name
    }
    return { type: 'tool-call-chunks', seq0, time0, data }
  }
  return {
    type: tag,
    seq0,
    time0,
    data: { turn, step, index, dt, texts: shape.payload },
  }
}

/** Reconstruct one member's stream chunk from a validated packed row. */
function streamChunkFromRow(row: ChunkRow, member: string): StreamChunk {
  switch (row.type) {
    case 'text-chunks':
      return { type: 'text-delta', index: row.data.index, text: member }
    case 'reasoning-chunks':
      return { type: 'reasoning-delta', index: row.data.index, text: member }
    case 'tool-call-chunks': {
      const name = Object.hasOwn(row.data, 'name') ? row.data.name : undefined
      return {
        type: 'tool-call-delta',
        index: row.data.index,
        id: row.data.id,
        ...name === undefined ? {} : { name },
        argumentsDelta: member,
      }
    }
  }
}

/**
 * Expand a validated row back into its exact original events, in order.
 * @param row - a row that passed its format's validation.
 * @returns the events the row stores, in log order.
 */
export function expandChunkRow(row: ChunkRow): SessionEvent[] {
  const members = row.type === 'tool-call-chunks' ? row.data.args : row.data.texts
  const events: SessionEvent[] = []
  let time = row.time0
  for (let index = 0; index < members.length; index++) {
    if (index > 0) {
      const gap = row.data.dt[index - 1]
      if (gap === undefined) {
        throw new Error(`chunk-run-codec row dt missing gap ${String(index - 1)}`)
      }
      time += gap
    }
    const member = members[index]
    if (member === undefined) {
      throw new Error(`chunk-run-codec row member ${String(index)} missing`)
    }
    const chunk = streamChunkFromRow(row, member)
    events.push({
      type: 'assistant/chunk',
      seq: row.seq0 + index,
      time,
      data: { turn: row.data.turn, step: row.data.step, chunk },
    })
  }
  return events
}

/**
 * Decode one parsed record into the session event(s) it stores.
 * Chunk-row-tagged values validate through the caller's format rules and
 * expand (a malformed row throws — it is corrupt storage, and treating it as an
 * event would silently drop a whole run); every other value passes through
 * unvalidated.
 *
 * @param value - one stored record, already parsed.
 * @param validate - the format's row validation, which throws on a malformed row.
 * @returns the stored records, in log order.
 */
export function decodeChunkStorageRecord(
  value: unknown,
  validate: (value: Record<string, unknown>, tag: ChunkRow['type']) => ChunkRow,
): unknown[] {
  if (!isRecord(value)) return [value]
  const tag = value.type
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') {
    return [value]
  }
  return expandChunkRow(validate(value, tag))
}
