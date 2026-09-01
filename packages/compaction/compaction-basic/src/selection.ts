/**
 * Surface retention selection for automatic and manual compaction. Chooses the
 * balanced span to shadow — either extending existing checkpoints from the head
 * (consolidation) or starting after one leading checkpoint to summarize only
 * new content — and names why no span exists. The priced snapshot for a chosen
 * span and the replay input built from it live here too, so the transaction
 * module stays purely sequential.
 *
 * @module @deepseek-ai/dsh-compaction-basic/selection
 */

import {
  isCompactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { settleCall } from './settle.ts'
import type { SummarizationInput } from './summarizer.ts'

/**
 * Smallest non-checkpoint span worth a separate summarization call, in route
 * tokens. A skip-checkpoint span at or below this floor would likely fail the
 * shrink comparison, so selection consolidates from the head instead.
 */
export const MIN_SKIP_SPAN_ROUTE_TOKENS = 512

/** How the chosen span relates to already-landed checkpoints. */
export type CompactRangeStrategy = 'skip-checkpoint' | 'consolidate'

/** Why no balanced span exists for the requested retention. */
export type CompactRangeUnavailableReason = 'empty' | 'all-retained' | 'unbalanced' | 'checkpoint-only'

/** Selection policy dials; `auto` prefers skipping one leading checkpoint. */
export interface CompactRangeSelectionOptions {
  readonly strategy?: 'auto' | 'consolidate'
}

/** Either one validated span with its strategy, or the reason none exists. */
export type CompactRangeSelection =
  | {
    readonly kind: 'range'
    readonly start: number
    readonly end: number
    readonly strategy: CompactRangeStrategy
  }
  | { readonly kind: 'none'; readonly reason: CompactRangeUnavailableReason }

/** One validated inclusive span of current surface positions. */
export interface SurfaceSelection {
  readonly start: number
  readonly end: number
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly number[]
}

/** A selection with its priced snapshot and the replay input built from it. */
export interface PreparedCompaction extends SurfaceSelection {
  readonly measurement: TokenMeasurement
  readonly selectedNodes: TokenMeasurement['nodes']
  readonly shadowedTokenCount: number
  /** Route-priced total of the selected span; the shrink comparison's unit. */
  readonly shadowedRouteTokenCount: number
  readonly input: SummarizationInput
}

/**
 * Rejects a summary whose replacement boundaries are no longer the ones it was
 * built from, distinguished from summarizer and shrink failures so a manual
 * caller can report the two causes differently.
 */
export class SurfaceChangedError extends Error {}

/**
 * Resolve the retention walk into one balanced span, deciding between
 * consolidating from the surface head and starting after one leading
 * checkpoint, and never splitting an assistant tool-call/result pair.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the conversation meter.
 * @param retainTokens - minimum recent tail budget retained verbatim.
 * @param options - explicit consolidation strategy; `auto` prefers skipping one leading checkpoint.
 * @returns the chosen span with its strategy, or the reason no span exists.
 */
export function selectCompactableRange(
  session: Session,
  measurement: TokenMeasurement,
  retainTokens: number,
  options: CompactRangeSelectionOptions = {},
): CompactRangeSelection {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return { kind: 'none', reason: 'empty' }

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('compaction: token-meter surface does not match the current session surface')
  }

  // Retention walk over the reversed priced nodes: keep the smallest tail
  // whose estimated size reaches the retained budget.
  let accumulated = 0
  let retainedCount = 0
  for (const node of [...pricedNodes].reverse()) {
    accumulated += node.tokens
    retainedCount += 1
    if (accumulated >= retainTokens) break
  }
  if (retainedCount === pricedNodes.length) return { kind: 'none', reason: 'all-retained' }
  let keepFromIdx = pricedNodes.length - retainedCount

  // Balance walk: extend retention head-ward until the cut before the first
  // retained node does not split a tool-call/result pair.
  for (const cutNodeSeq of surfaceNodes.slice(1, keepFromIdx + 1).reverse()) {
    if (toolPairingBalancedBefore(session, cutNodeSeq)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx === 0) return { kind: 'none', reason: 'unbalanced' }

  const leading = leadingCheckpointFacts(session, surfaceNodes).count
  const strategy = options.strategy === 'consolidate'
    ? 'consolidate'
    : resolveAutoStrategy(leading, keepFromIdx, pricedNodes)
  // A consolidation span that shadows nothing but one leading checkpoint has
  // nothing new to condense; re-summarizing it would tie the shrink check.
  if (strategy === 'consolidate' && keepFromIdx === 1 && leading >= 1) {
    return { kind: 'none', reason: 'checkpoint-only' }
  }
  let startSeq = firstSeq(surfaceNodes)
  if (strategy === 'skip-checkpoint') {
    startSeq = firstSeq(surfaceNodes.slice(leading))
  }
  const endSeq = firstSeq(surfaceNodes.slice(keepFromIdx - 1, keepFromIdx))
  return { kind: 'range', start: startSeq, end: endSeq, strategy }
}

/** The first seq of a non-empty seq list. */
function firstSeq(seqs: readonly number[]): number {
  for (const seq of seqs) return seq
  /* v8 ignore next -- callers pass non-empty lists */
  throw new Error('compaction: firstSeq on an empty surface list')
}

/**
 * Choose between skipping one leading checkpoint and consolidating from the
 * head. Skip only when exactly one checkpoint leads and the non-checkpoint
 * span reaches the minimum useful size; zero, two, or more leading checkpoints
 * consolidate so the surface never accumulates a chain of summaries.
 */
function resolveAutoStrategy(
  leading: number,
  keepFromIdx: number,
  pricedNodes: TokenMeasurement['nodes'],
): CompactRangeStrategy {
  if (leading !== 1 || leading >= keepFromIdx) return 'consolidate'
  const skipTokens = pricedNodes
    .slice(leading, keepFromIdx)
    .reduce((total, node) => total + node.tokens, 0)
  return skipTokens >= MIN_SKIP_SPAN_ROUTE_TOKENS ? 'skip-checkpoint' : 'consolidate'
}

/** Consecutive compaction-checkpoint nodes at the surface head. */
function leadingCheckpointFacts(session: Session, surfaceNodes: readonly number[]): { count: number } {
  const events = session.events
  let count = 0
  for (const seq of surfaceNodes) {
    const event = events[seq]
    /* v8 ignore next -- surface nodes are current seqs of a validated log, so every entry exists and matches */
    if (event === undefined || event.seq !== seq) {
      throw new Error(`compaction: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    if (!isCheckpointEvent(event)) return { count }
    count += 1
  }
  return { count }
}

/** Whether one surface event is a compaction checkpoint replacement message. */
function isCheckpointEvent(event: SessionEvent): boolean {
  return event.type === 'user/message' && isCompactCheckpointSource(event.data.source)
}

/**
 * Snapshot pricing and replay input for a validated surface range.
 * @param meter - conversation meter supplying the priced snapshot.
 * @param session - session supplying the request header and per-node projection.
 * @param selection - validated span whose snapshot is prepared.
 * @returns the priced snapshot and replay input.
 */
export function prepareCompaction(
  meter: TokenMeter,
  session: Session,
  selection: SurfaceSelection,
): PreparedCompaction {
  const measurement = meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new SurfaceChangedError('compaction: selected surface changed before summarization began')
  }
  return {
    ...selection,
    measurement,
    selectedNodes,
    // The shadow-price protocol prices replacements with the fixed heuristic
    // so the O(1) projection fold stays in agreement with its own appends;
    // retention, range selection, and the shrink comparison read the
    // route-priced `tokens` instead.
    shadowedTokenCount: selectedNodes.reduce((total, node) => total + node.heuristicTokens, 0),
    shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + node.tokens, 0),
    input: buildSummarizationInput(session, selection.shadowedSeqs),
  }
}

/**
 * Reconstruct the last routed request's cacheable prefix for the shadowed
 * region: its system prompt and tool schemas, then the region's own derived
 * messages in surface order. The summarizer appends only the compaction
 * instruction after this, so the call is a genuine prefix of the conversation
 * and reuses the provider's KV cache.
 * @param session - session supplying the request header and per-node projection.
 * @param shadowedSeqs - the surface-node seqs, in order, being compacted.
 * @returns the replayed conversation prefix to condense.
 */
function buildSummarizationInput(
  session: Session,
  shadowedSeqs: readonly number[],
): SummarizationInput {
  const header = session.requestHeader()
  const events = session.events
  const regionMessages: Message[] = []
  for (const seq of shadowedSeqs) {
    const event = events[seq]
    /* v8 ignore next -- shadowed seqs are current surface seqs of a validated log, so every entry exists and matches */
    if (event === undefined || event.seq !== seq) {
      throw new Error(`compaction: surface seq ${seq} has no matching session event (corrupt surface)`)
    }
    const message = session.deriveEventMessage(event)
    /* v8 ignore next -- shadowed surface nodes always derive a message */
    if (message !== null) regionMessages.push(message)
  }
  return {
    ...header?.system === undefined ? {} : { system: header.system },
    ...header?.tools === undefined ? {} : { tools: header.tools },
    messages: regionMessages,
  }
}

/**
 * Validate one requested surface-position span before asynchronous work begins.
 * @param session - session whose current surface is checked.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @returns the validated span with its positions and shadowed seqs.
 */
export function validateSurfaceRegion(session: Session, start: number, end: number): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`compactRegion: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`compactRegion: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  if (!toolPairingBalancedBefore(session, start)) {
    throw new Error(`compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`)
  }
  if (!toolPairingBalancedAfter(session, end)) {
    throw new Error(`compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`)
  }

  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/**
 * Reject a summary prepared against any earlier surface generation.
 * @param meter - conversation meter supplying the current measurement.
 * @param session - session whose surface is remeasured.
 * @param prepared - snapshot whose whole-surface agreement is required.
 */
export function assertWholeSurfaceUnchanged(
  meter: TokenMeter,
  session: Session,
  prepared: PreparedCompaction,
): void {
  const current = meter.measure(session)
  if (!samePricedNodes(current.nodes, prepared.measurement.nodes)) {
    throw new SurfaceChangedError('compaction: session surface changed during summarization')
  }
}

/**
 * Require only that the selected span remain the same present, contiguous,
 * equally priced, balanced replacement target. Nodes added outside it remain
 * visible and do not invalidate the summary.
 * @param meter - conversation meter supplying the current pricing.
 * @param session - session whose selected span is revalidated.
 * @param prepared - snapshot whose selected span must stay unchanged.
 */
export async function assertSelectedSpanStable(
  meter: TokenMeter,
  session: Session,
  prepared: PreparedCompaction,
): Promise<void> {
  const validated = await settleCall(() => validateSurfaceRegion(session, prepared.start, prepared.end))
  if (validated.status === 'rejected') {
    throw new SurfaceChangedError(
      'compaction: the selected span is no longer a valid replacement target',
      { cause: validated.reason },
    )
  }
  const current = validated.value
  if (!sameSeqs(current.shadowedSeqs, prepared.shadowedSeqs)) {
    throw new SurfaceChangedError('compaction: the selected span changed during summarization')
  }
  const measured = meter.measure(session).nodes.slice(current.startIdx, current.endIdx + 1)
  if (!samePricedNodes(measured, prepared.selectedNodes)) {
    throw new SurfaceChangedError('compaction: the selected span was rewritten during summarization')
  }
}

/**
 * Encode the priced fields of one surface node run, so two runs compare by
 * value without indexing one list against the other.
 * @param nodes - priced surface nodes to encode.
 * @returns one string carrying every node's seq and both token prices in order.
 */
function pricedNodeDigest(nodes: readonly TokenMeasurement['nodes'][number][]): string {
  return nodes.map(node => `${node.seq}:${node.tokens}:${node.heuristicTokens}`).join('|')
}

/** Field-precise equality over token-priced surface nodes. */
function samePricedNodes(
  left: readonly TokenMeasurement['nodes'][number][],
  right: readonly TokenMeasurement['nodes'][number][],
): boolean {
  return pricedNodeDigest(left) === pricedNodeDigest(right)
}

/** Order-sensitive equality over surface seq lists. */
function sameSeqs(left: readonly number[], right: readonly number[]): boolean {
  /* v8 ignore next -- both sides slice the same validated span, so lengths always agree */
  if (left.length !== right.length) return false
  return !left.some((seq, index) => seq !== right[index])
}
