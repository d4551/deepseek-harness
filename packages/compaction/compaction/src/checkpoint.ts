/**
 * Compaction checkpoint provenance: the correlated source constructor and type
 * every backend uses for its replacement user message, plus the predicate that
 * recognizes persisted checkpoints.
 *
 * The seam itself lives in `@deepseek-ai/dsh-compaction`, which re-exports these
 * contracts; this module is a pure type/value/predicate outlet (no cordis
 * imports, no module augmentation) so client and wire programs can name the
 * checkpoint source without loading the host plugin's Context merges — the
 * `dsh-commands/brand` shape.
 *
 * @module @deepseek-ai/dsh-compaction/checkpoint
 */

import type { MessageSource } from '@deepseek-ai/dsh-llm/message'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { CompactionId } from './brand.ts'

const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'plugin', plugin: 'compact' } as const)

/** Message provenance carried by a concrete compaction checkpoint. */
export type CompactionCheckpointSource = typeof COMPACT_CHECKPOINT_MARKER & {
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
}

/**
 * Create checkpoint provenance correlated with one compaction transaction.
 * @param compactionId - owning compaction identity.
 * @param sourceCommandId - initiating manual command, when present.
 * @returns immutable checkpoint source.
 */
export function compactCheckpointSource(
  compactionId: CompactionId,
  sourceCommandId?: CommandId,
): CompactionCheckpointSource {
  return Object.freeze({
    ...COMPACT_CHECKPOINT_MARKER,
    compactionId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
  })
}

/**
 * Rebuild a compaction checkpoint from persisted message provenance.
 * @param source - source restored from a surface user message.
 * @returns the checkpoint source, or undefined when the provenance is not a compact checkpoint.
 */
export function readCompactCheckpointSource(
  source: MessageSource,
): CompactionCheckpointSource | undefined {
  if (source.kind !== 'plugin' || source.plugin !== COMPACT_CHECKPOINT_MARKER.plugin) return undefined
  if (!('compactionId' in source) || typeof source.compactionId !== 'string' || source.compactionId === '') {
    return undefined
  }
  const rawCommandId = 'sourceCommandId' in source ? source.sourceCommandId : undefined
  if (rawCommandId !== undefined && typeof rawCommandId !== 'string') return undefined
  return compactCheckpointSource(
    CompactionId(source.compactionId),
    rawCommandId === undefined ? undefined : CommandId(rawCommandId),
  )
}

/**
 * Test whether a persisted message source identifies a compaction checkpoint.
 * @param source - source restored from a surface user message.
 * @returns whether the source carries a compact plugin marker and a compaction id.
 */
export function isCompactCheckpointSource(source: MessageSource): boolean {
  return readCompactCheckpointSource(source) !== undefined
}
