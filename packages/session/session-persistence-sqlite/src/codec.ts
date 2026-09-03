/**
 * Schema-19 physical chunk-row packing: the member and byte limits a SQLite
 * data column accepts, and the run splitting that keeps every emitted row
 * inside them. The row vocabulary and the lossless transforms are the ones
 * `@deepseek-ai/dsh-session/chunk-run-codec` defines, so a stored schema-19 row
 * and a stored JSONL row are the same physical encoding; only the limits and
 * the splitting below are this schema's own.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/codec
 */

import {
  buildChunkRow,
  decodeChunkStorageRecord,
  expandChunkRow,
  malformedChunkRow,
  scanChunkRuns,
  validateChunkRowShape,
} from '@deepseek-ai/dsh-session/chunk-run-codec'
import type { ChunkRow, DeltaChunkEvent, DeltaChunkKind, StorageRecord } from '@deepseek-ai/dsh-session/chunk-run-codec'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type { ChunkRow, StorageRecord } from '@deepseek-ai/dsh-session/chunk-run-codec'

/** Minimum eligible members in a packed physical record. */
export const MIN_PACKED_ROW_MEMBERS = 3
/** Maximum logical members represented by one packed physical record. */
export const MAX_PACKED_ROW_MEMBERS = 1_024
/** Maximum UTF-8 bytes in one packed physical record's data column. */
export const MAX_PACKED_DATA_BYTES = 1_048_576

function packedDataBytes(row: ChunkRow): number {
  return Buffer.byteLength(JSON.stringify(row.data))
}

function emitBoundedRun(out: StorageRecord[], kind: DeltaChunkKind, completeRun: readonly DeltaChunkEvent[]): void {
  let offset = 0
  while (completeRun.length - offset >= MIN_PACKED_ROW_MEMBERS) {
    let low = MIN_PACKED_ROW_MEMBERS
    let high = Math.min(completeRun.length - offset, MAX_PACKED_ROW_MEMBERS)
    const largest = buildChunkRow(kind, completeRun.slice(offset, offset + high))
    if (packedDataBytes(largest) <= MAX_PACKED_DATA_BYTES) {
      out.push(largest)
      offset += high
      continue
    }
    high -= 1
    let accepted = 0
    let acceptedRow: ChunkRow | undefined
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = buildChunkRow(kind, completeRun.slice(offset, offset + middle))
      if (packedDataBytes(candidate) <= MAX_PACKED_DATA_BYTES) {
        accepted = middle
        acceptedRow = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (accepted === 0) {
      out.push(completeRun[offset] as DeltaChunkEvent)
      offset += 1
      continue
    }
    /* v8 ignore next -- accepted is set only with its same-branch candidate. */
    out.push(acceptedRow ?? malformedChunkRow(kind, 'bounded encoder lost its accepted row'))
    offset += accepted
  }
  out.push(...completeRun.slice(offset))
}

/**
 * Pack eligible logical chunk runs into bounded schema-19 records.
 * @param events - logical events in sequence order.
 * @returns scalar and packed physical records in equivalent order.
 */
export function packChunkRuns(events: readonly SessionEvent[]): StorageRecord[] {
  return scanChunkRuns(events, emitBoundedRun)
}

/** Validate one parsed row against the schema-19 member and byte limits. */
function validateRow(
  value: Record<string, unknown>,
  tag: ChunkRow['type'],
  serializedBytes?: number,
): ChunkRow {
  const { data, payloadKey, payload } = validateChunkRowShape(value, tag)
  if (payload.length < MIN_PACKED_ROW_MEMBERS || payload.length > MAX_PACKED_ROW_MEMBERS) {
    malformedChunkRow(tag, `${payloadKey} must contain ${MIN_PACKED_ROW_MEMBERS}..${MAX_PACKED_ROW_MEMBERS} strings`)
  }
  if ((serializedBytes ?? Buffer.byteLength(JSON.stringify(data))) > MAX_PACKED_DATA_BYTES) {
    malformedChunkRow(tag, `data exceeds ${MAX_PACKED_DATA_BYTES} UTF-8 bytes`)
  }
  return value as unknown as ChunkRow
}

/**
 * Decode one scalar or packed schema-19 record.
 * @param value - parsed physical-record value.
 * @returns the represented logical events.
 */
export function decodeStorageRecord(value: unknown): SessionEvent[] {
  return decodeChunkStorageRecord(value, validateRow)
}

/**
 * Decode one packed row from its exact uncompressed data value. The byte bound
 * rejects oversized input before JSON parsing and avoids serializing it again.
 * @param tag - validated packed physical type.
 * @param seq0 - first represented logical sequence number.
 * @param time0 - first represented logical timestamp.
 * @param serializedData - decoded SQLite data-column text.
 * @returns the represented logical events.
 */
export function decodeSerializedChunkRow(
  tag: ChunkRow['type'],
  seq0: number,
  time0: number,
  serializedData: string,
): SessionEvent[] {
  const bytes = Buffer.byteLength(serializedData)
  if (bytes > MAX_PACKED_DATA_BYTES) malformedChunkRow(tag, `data exceeds ${MAX_PACKED_DATA_BYTES} UTF-8 bytes`)
  return expandChunkRow(validateRow({ type: tag, seq0, time0, data: JSON.parse(serializedData) as unknown }, tag, bytes))
}
