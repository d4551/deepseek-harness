/**
 * Assistant block accumulation shared by every Conversation target: the walk
 * from `assistant/chunk`, chunk-run, and `assistant/message` events to the
 * blocks, visible-block count, and first-visible/first-token boundaries a
 * transcript row needs. Targets add their own state around this value and
 * build their own view node from it; the walk itself has one owner.
 * @module @deepseek-ai/dsh-client-ui-conversation/src/client/projection/assistant-stream
 */

import type { ChunkRowEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type {
  ConversationLocation, ConversationMatch, ConversationPublication,
} from '../contract/conversation.ts'
import type { AssistantBlock, AssistantMessageNode } from '../contract/records.ts'
import { emptyAssistantBlock, isTokenDelta, toAssistantBlock, toAssistantBlocks } from './event-projection.ts'

/**
 * Relative positions in one durable event's seq neighborhood: interrupted
 * Assistant, its follow-up Nodes, then follow-ups to an ordinary final. The
 * max-tokens notice sits between a closing Assistant and the turn-tail so the
 * tail stays the turn's last node and keeps its branch action enabled. Every
 * target orders its synthetic Nodes against the same engine boundaries, so the
 * scheme has one owner.
 */
export const SYNTHETIC_SEQ_OFFSETS = {
  interruptedAssistant: -0.9,
  interruptedFollowup: -0.8,
  processControl: -0.1,
  maxTokensNotice: 0.05,
  finalizedFollowup: 0.1,
} as const

/** Accumulated Assistant blocks and the timing boundaries derived from them. */
export interface AssistantStream {
  /** Blocks by stream index; a gap stays `undefined` until its first delta. */
  readonly blocks: readonly (AssistantBlock | undefined)[]
  /** How many accumulated blocks currently render as visible content. */
  readonly visibleBlocks: number
  /** Event seq at which visible content first appeared. */
  readonly firstVisibleSeq: number | undefined
  /** Unix epoch ms at which visible content first appeared. */
  readonly firstVisibleTime: number | undefined
  /** Unix epoch ms of the first non-empty delta. */
  readonly firstTokenTime: number | undefined
}

/** A stream with no accumulated block and no recorded boundary. */
export const EMPTY_ASSISTANT_STREAM: AssistantStream = {
  blocks: [],
  visibleBlocks: 0,
  firstVisibleSeq: undefined,
  firstVisibleTime: undefined,
  firstTokenTime: undefined,
}

/**
 * Whether an event is one of the coalesced chunk-run rows.
 * @param event - matched session event.
 * @returns whether it carries a text, reasoning, or tool-call chunk run.
 */
export function isChunkRunEvent(event: ConversationMatch['event']): event is ChunkRowEvent {
  return event.type === 'chunkrow/text-chunks'
    || event.type === 'chunkrow/reasoning-chunks'
    || event.type === 'chunkrow/tool-call-chunks'
}

/**
 * Drop the index gaps a partially received stream leaves behind.
 * @param blocks - accumulated blocks, indexed by stream position.
 * @returns the received blocks in index order.
 */
export function compactBlocks(blocks: readonly (AssistantBlock | undefined)[]): AssistantBlock[] {
  return blocks.filter((block): block is AssistantBlock => block !== undefined)
}

/**
 * Whether one block currently renders as visible content.
 * @param block - accumulated block, or a gap.
 * @returns false for a gap, a Tool call, and whitespace-only text or reasoning.
 */
export function blockIsVisible(block: AssistantBlock | undefined): boolean {
  if (block === undefined || block.kind === 'tool-call') return false
  if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
  return true
}

/** Count the blocks that render as visible content. */
function countVisibleBlocks(blocks: readonly AssistantBlock[]): number {
  let count = 0
  for (const block of blocks) if (blockIsVisible(block)) count++
  return count
}

/**
 * Whether a frozen prefix carries enough content to render an interruption.
 * Unlike {@link blockIsVisible} a Tool call counts: an interrupted call is the
 * evidence that the step was cut off.
 */
function hasInterruptionEvidence(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some((block) => {
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text.trim() !== ''
    return true
  })
}

/**
 * Replace the accumulated blocks with a finalized message's content.
 * @param content - content blocks of the durable `assistant/message`.
 * @returns the finalized blocks and their visible count.
 */
export function settledBlocks(
  content: readonly ContentBlock[],
): { blocks: AssistantBlock[]; visibleBlocks: number } {
  const blocks = toAssistantBlocks(content)
  return { blocks, visibleBlocks: countVisibleBlocks(blocks) }
}

/**
 * Apply one streamed chunk to the accumulated blocks.
 * @param stream - accumulated stream before the chunk.
 * @param chunk - the streamed chunk.
 * @param seq - event seq carrying the chunk.
 * @param time - Unix epoch ms of the event carrying the chunk.
 * @returns the advanced stream, or null when the chunk changes no block
 * (`usage`, `finish`, and any chunk kind this version does not accumulate) and
 * the caller owns what that means for its own state.
 */
export function applyAssistantChunk(
  stream: AssistantStream,
  chunk: StreamChunk,
  seq: number,
  time: number,
): AssistantStream | null {
  const blocks = [...stream.blocks]
  let changedIndex = -1
  let previousVisible = false
  switch (chunk.type) {
    case 'block-start':
      changedIndex = chunk.index
      previousVisible = blockIsVisible(blocks[chunk.index])
      blocks[chunk.index] = emptyAssistantBlock(chunk.blockType)
      break
    case 'text-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      blocks[chunk.index] = {
        kind: 'text',
        text: (previous?.kind === 'text' ? previous.text : '') + chunk.text,
      }
      break
    }
    case 'reasoning-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      blocks[chunk.index] = {
        kind: 'reasoning',
        text: (previous?.kind === 'reasoning' ? previous.text : '') + chunk.text,
      }
      break
    }
    case 'tool-call-delta': {
      const previous = blocks[chunk.index]
      changedIndex = chunk.index
      previousVisible = blockIsVisible(previous)
      const base = previous?.kind === 'tool-call'
        ? previous
        : { kind: 'tool-call' as const, callId: '', name: '', argsRaw: '' }
      blocks[chunk.index] = {
        kind: 'tool-call',
        callId: base.callId || String(chunk.id),
        name: chunk.name ?? base.name,
        argsRaw: base.argsRaw + chunk.argumentsDelta,
      }
      break
    }
    case 'block-end':
      changedIndex = chunk.index
      previousVisible = blockIsVisible(blocks[chunk.index])
      blocks[chunk.index] = toAssistantBlock(chunk.block)
      break
    default:
      return null
  }
  const visibleBlocks = stream.visibleBlocks
    - Number(previousVisible)
    + Number(blockIsVisible(blocks[changedIndex]))
  return {
    ...stream,
    blocks,
    visibleBlocks,
    ...(visibleBlocks > 0 && stream.firstVisibleSeq === undefined
      ? { firstVisibleSeq: seq, firstVisibleTime: time }
      : {}),
    ...(isTokenDelta(chunk) && stream.firstTokenTime === undefined
      ? { firstTokenTime: time }
      : {}),
  }
}

interface ChunkRunBoundaries {
  readonly firstTokenTime: number | undefined
  readonly firstVisible: { readonly seq: number; readonly time: number } | undefined
}

/**
 * Walk one coalesced chunk run for the boundaries the stream still needs.
 * A run replays as one event, so each fragment's own time is reconstructed
 * from the run's recorded inter-fragment deltas.
 */
function chunkRunBoundaries(
  event: ChunkRowEvent,
  needsToken: boolean,
  needsVisible: boolean,
  visibleFromStart: boolean,
): ChunkRunBoundaries {
  const fragments = event.type === 'chunkrow/tool-call-chunks' ? event.data.args : event.data.texts
  const nameStartsToken = event.type === 'chunkrow/tool-call-chunks'
    && Object.hasOwn(event.data, 'name')
  let firstTokenTime: number | undefined
  let firstVisible: ChunkRunBoundaries['firstVisible']
  let time = event.time
  for (let index = 0; index < fragments.length; index++) {
    const fragment = fragments[index] as string
    if (needsToken && firstTokenTime === undefined && (nameStartsToken || fragment !== '')) {
      firstTokenTime = time
    }
    if (needsVisible && firstVisible === undefined
      && (visibleFromStart
        || (event.type !== 'chunkrow/tool-call-chunks' && fragment.trim() !== ''))) {
      firstVisible = { seq: event.seq + index, time }
    }
    if ((!needsToken || firstTokenTime !== undefined)
      && (!needsVisible || firstVisible !== undefined)) break
    time += event.data.dt[index] ?? 0
  }
  return { firstTokenTime, firstVisible }
}

/**
 * Apply one coalesced chunk run to the accumulated blocks.
 * @param stream - accumulated stream before the run.
 * @param event - the chunk-run event.
 * @returns the advanced stream.
 */
export function applyChunkRun(stream: AssistantStream, event: ChunkRowEvent): AssistantStream {
  const blocks = [...stream.blocks]
  const previous = blocks[event.data.index]
  const previousVisible = blockIsVisible(previous)
  let visibleFromStart = stream.visibleBlocks - Number(previousVisible) > 0
  if (event.type === 'chunkrow/text-chunks') {
    const text = previous?.kind === 'text' ? previous.text : ''
    visibleFromStart ||= text.trim() !== ''
    blocks[event.data.index] = { kind: 'text', text: text + event.data.texts.join('') }
  } else if (event.type === 'chunkrow/reasoning-chunks') {
    const text = previous?.kind === 'reasoning' ? previous.text : ''
    visibleFromStart ||= text.trim() !== ''
    blocks[event.data.index] = { kind: 'reasoning', text: text + event.data.texts.join('') }
  } else {
    const base = previous?.kind === 'tool-call'
      ? previous
      : { kind: 'tool-call' as const, callId: '', name: '', argsRaw: '' }
    blocks[event.data.index] = {
      kind: 'tool-call',
      callId: base.callId || String(event.data.id),
      name: Object.hasOwn(event.data, 'name') ? event.data.name as string : base.name,
      argsRaw: base.argsRaw + event.data.args.join(''),
    }
  }
  const boundaries = chunkRunBoundaries(
    event,
    stream.firstTokenTime === undefined,
    stream.firstVisibleSeq === undefined,
    visibleFromStart,
  )
  const visibleBlocks = stream.visibleBlocks
    - Number(previousVisible)
    + Number(blockIsVisible(blocks[event.data.index]))
  return {
    ...stream,
    blocks,
    visibleBlocks,
    ...(boundaries.firstVisible === undefined ? {} : {
      firstVisibleSeq: boundaries.firstVisible.seq,
      firstVisibleTime: boundaries.firstVisible.time,
    }),
    ...(boundaries.firstTokenTime === undefined ? {} : {
      firstTokenTime: boundaries.firstTokenTime,
    }),
  }
}

/**
 * Read the closing seq/time of a step or turn that already closed.
 * @param location - location of the step's start or last match.
 * @returns the closing boundary, or undefined while the step and turn are open.
 */
export function closedLocationBoundary(
  location: ConversationLocation | undefined,
): { seq: number; time: number } | undefined {
  if (location?.kind === 'step' && location.step.status === 'closed') return location.step.end
  if ((location?.kind === 'step' || location?.kind === 'turn')
    && location.turn.status === 'closed') return location.turn.end
  return undefined
}

/** How one target presents the settled node of an Assistant step. */
export interface AssistantFinalOptions {
  /** Matching step/start timestamp, or null when it is outside the event window. */
  readonly stepStartTime: number | null
  /** Whether the target presents the request's provider/model identity. */
  readonly withProvenance: boolean
}

/** The Assistant-step state {@link assistantFinalNode} reads. */
export interface AssistantFinalState {
  readonly turn: number
  readonly step: number
  /** The matched `assistant/message`, once the step settled. */
  readonly final: ConversationMatch | undefined
  readonly stream: AssistantStream
}

/**
 * Project the settled node of one Assistant step: the durable
 * `assistant/message` when the step produced one, otherwise the chunk-only
 * prefix frozen at the closing boundary of a step or turn that cut it off.
 * @param state - the step's identity, settlement match, and accumulated stream.
 * @param options - the target's timing source and provenance choice.
 * @param boundary - closing seq/time of the step or turn, when it closed.
 * @returns the settled or interrupted node, or undefined while the step is
 * still open or its frozen prefix carries no interruption evidence.
 */
export function assistantFinalNode(
  state: AssistantFinalState,
  options: AssistantFinalOptions,
  boundary: { seq: number; time: number } | undefined,
): AssistantMessageNode | undefined {
  const final = state.final
  if (final?.event.type === 'assistant/message') {
    const event = final.event
    return {
      kind: 'assistant',
      seq: event.seq,
      messageId: event.data.message.id,
      time: event.time,
      turn: state.turn,
      step: state.step,
      blocks: toAssistantBlocks(event.data.message.content),
      usage: event.data.usage,
      ...(options.withProvenance
        ? {
          provenance: {
            provider: event.data.message.source.provider,
            model: event.data.message.source.model,
          },
        }
        : {}),
      timing: {
        stepStartTime: options.stepStartTime,
        firstTokenTime: state.stream.firstTokenTime ?? null,
        completedTime: event.time,
      },
      ...(event.data.interrupted === true ? { interrupted: true } : {}),
    }
  }
  if (boundary === undefined) return undefined
  const blocks = compactBlocks(state.stream.blocks)
  if (!hasInterruptionEvidence(blocks)) return undefined
  return {
    kind: 'assistant',
    seq: boundary.seq + SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
    time: boundary.time,
    turn: state.turn,
    step: state.step,
    blocks,
    interrupted: true,
  }
}

/**
 * Publication cadence of one Assistant-step match: chunk runs and content
 * deltas coalesce into an animation frame, bookkeeping chunks publish nothing,
 * and every other match publishes immediately.
 * @param match - the matched event.
 * @returns the cadence the assembler applies.
 */
export function assistantStepPublication(match: ConversationMatch): ConversationPublication {
  if (match.event.type === 'step/start') return 'none'
  if (isChunkRunEvent(match.event)) return 'animation-frame'
  if (match.event.type !== 'assistant/chunk') return 'immediate'
  const type = match.event.data.chunk.type
  return type === 'usage' || type === 'finish' ? 'none' : 'animation-frame'
}
