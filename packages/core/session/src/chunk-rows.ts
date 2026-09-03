/**
 * The JSONL log's chunk-run packing: one row per run of at least
 * {@link MIN_RUN} members, with no upper bound on a row's members or bytes
 * because a JSONL line has none. Persistence and bounded history transport both
 * use it. The row vocabulary and the lossless transforms it packs and expands
 * with are owned by {@link ./chunk-run-codec.ts | chunk-run-codec}.
 *
 * @module @deepseek-ai/dsh-session/chunk-rows
 */

import {
  buildChunkRow,
  decodeChunkStorageRecord,
  scanChunkRuns,
  validateChunkRowShape,
} from './chunk-run-codec.ts'
import type { ChunkRow, StorageRecord } from './chunk-run-codec.ts'
import type { SessionEvent } from './types.ts'

export { chunkRowLength, isChunkRow } from './chunk-run-codec.ts'
export type { ChunkRow, StorageRecord } from './chunk-run-codec.ts'

/**
 * Minimum members before a run packs. Below it a row's envelope rivals the
 * event lines it replaces. A format constant, not a tunable: both layouts
 * decode identically, so changing it never invalidates stored logs.
 */
const MIN_RUN = 3

/**
 * Pack an event batch for storage: each run of at least {@link MIN_RUN}
 * consecutive whitelisted same-kind, same-block delta chunk events becomes one
 * {@link ChunkRow}; every other event passes through verbatim, in order.
 *
 * @param events - the batch to encode, in log order.
 * @returns the storage records to write, one JSONL line each.
 */
export function packChunkRuns(events: readonly SessionEvent[]): StorageRecord[] {
  return scanChunkRuns(events, (out, kind, run) => {
    if (run.length >= MIN_RUN) out.push(buildChunkRow(kind, run))
    else out.push(...run)
  })
}

/** Validate a row-tagged parsed value; a JSONL line bounds neither members nor bytes. */
function validateRow(value: Record<string, unknown>, tag: ChunkRow['type']): ChunkRow {
  validateChunkRowShape(value, tag)
  return value as unknown as ChunkRow
}

/**
 * Decode one parsed JSONL line value into the session event(s) it stores.
 * @param value - one line's `JSON.parse` result.
 * @returns the stored events, in log order.
 */
export function decodeStorageRecord(value: unknown): SessionEvent[] {
  return decodeChunkStorageRecord(value, validateRow)
}
