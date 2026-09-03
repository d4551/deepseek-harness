import type { Context } from '@deepseek-ai/cordis'
import type { ChunkRowEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  EMPTY_ASSISTANT_STREAM, applyAssistantChunk, applyChunkRun, assistantFinalNode,
  assistantStepPublication, blockIsVisible, closedLocationBoundary, compactBlocks,
  isChunkRunEvent, settledBlocks,
  type AssistantStream, type ConversationMatch, type ConversationNodeContext,
  type ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { AssistantChatData } from '../contract/chat-nodes.ts'
// The declaring package, not the local barrel: a Typert-modeled reference must
// name the package that owns the type so the generated import can point at it.
import type { AssistantBlock, AssistantMessageNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Streaming, settled, or interrupted Assistant step. */
    'assistant-step': AssistantChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    /** Streaming, settled, or interrupted Assistant material for this Step. */
    'assistant-step': AssistantChatData
  }
}

/**
 * Chat's Assistant step state. Beyond the shared block accumulation Chat keeps
 * `hidden`, the retry-suppression flag that lets a step whose visible content a
 * retry threw away stay mounted instead of disappearing from the flow.
 */
interface AssistantState {
  readonly turn: number
  readonly step: number
  readonly stream: AssistantStream
  readonly hidden: boolean
  readonly final: ConversationMatch | undefined
  readonly usage: unknown
}

function initialState(turn: number, step: number): AssistantState {
  return {
    turn,
    step,
    stream: EMPTY_ASSISTANT_STREAM,
    hidden: false,
    final: undefined,
    usage: undefined,
  }
}

function hasVisibleContent(blocks: readonly AssistantBlock[]): boolean {
  return blocks.some(blockIsVisible)
}

function withStream(state: AssistantState, stream: AssistantStream): AssistantState {
  return { ...state, stream, hidden: stream.visibleBlocks > 0 ? false : state.hidden }
}

function resetForRetry(state: AssistantState): AssistantState {
  return {
    ...initialState(state.turn, state.step),
    stream: { ...EMPTY_ASSISTANT_STREAM, firstTokenTime: state.stream.firstTokenTime },
    hidden: true,
  }
}

function updateChunk(state: AssistantState, match: ConversationMatch): AssistantState {
  if (match.event.type !== 'assistant/chunk') return state
  const chunk = match.event.data.chunk
  const stream = applyAssistantChunk(state.stream, chunk, match.event.seq, match.event.time)
  if (stream !== null) return withStream(state, stream)
  return chunk.type === 'usage' ? { ...state, usage: chunk.usage } : state
}

function updateChunkRun(state: AssistantState, event: ChunkRowEvent): AssistantState {
  return withStream(state, applyChunkRun(state.stream, event))
}

function settle(state: AssistantState, match: ConversationMatch, usage: unknown): AssistantState {
  if (match.event.type !== 'assistant/message') return state
  const { blocks, visibleBlocks } = settledBlocks(match.event.data.message.content)
  return {
    ...state,
    stream: { ...state.stream, blocks, visibleBlocks },
    hidden: false,
    final: match,
    usage,
  }
}

function finalNode(
  state: AssistantState,
  context: ConversationNodeContext<AssistantState>,
): AssistantMessageNode | undefined {
  // Chat reads the step's start straight off the matched step/start event and
  // presents no provider identity; the row shows what the model wrote.
  return assistantFinalNode(
    state,
    { stepStartTime: context.start?.event.time ?? null, withProvenance: false },
    closedLocationBoundary(context.start?.location ?? context.matches.at(-1)?.location),
  )
}

function fallbackState(context: ConversationNodeContext<AssistantState>): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    if (isChunkRunEvent(match.event)) {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = updateChunkRun(state, match.event)
      continue
    }
    if (match.event.type === 'assistant/chunk') {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = updateChunk(state, match)
      continue
    }
    if (match.event.type === 'assistant/message') {
      state ??= initialState(match.event.data.turn, match.event.data.step)
      state = settle(state, match, match.event.data.usage)
      continue
    }
    if (match.event.type === 'llm/retry' && state !== undefined) {
      state = resetForRetry(state)
    }
  }
  return state
}

interface AssistantProjection {
  readonly data: AssistantChatData
  readonly anchorSeq: number
  readonly visible: boolean
  readonly settled: AssistantMessageNode | undefined
}

function projectAssistant(context: ConversationNodeContext<AssistantState>): AssistantProjection | undefined {
  const state = context.state ?? fallbackState(context)
  if (state === undefined) return undefined
  const settled = finalNode(state, context)
  const blocks = settled?.blocks ?? compactBlocks(state.stream.blocks)
  const visible = settled === undefined ? state.stream.visibleBlocks > 0 : hasVisibleContent(blocks)
  const status = settled?.interrupted === true
    ? 'interrupted'
    : settled === undefined ? 'running' : 'settled'
  const anchorSeq = settled?.seq ?? state.stream.firstVisibleSeq ?? context.matches[0]?.event.seq ?? 0
  const time = settled?.time ?? state.stream.firstVisibleTime ?? context.matches[0]?.event.time ?? 0
  return {
    anchorSeq,
    visible,
    settled,
    data: {
      status,
      turn: state.turn,
      step: state.step,
      blocks,
      time,
      ...state.usage === undefined ? {} : { usage: state.usage },
      ...settled === undefined ? {} : { finalNode: settled },
    },
  }
}

/** Per-step Assistant streaming/final/interruption Definition. */
export const assistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'assistant-step',
  target: 'chat',
  match: (event) => {
    if (event.type === 'step/start') return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    if (event.type === 'assistant/chunk'
      || (event.type === 'assistant/message' && isAppendSurfaceEvent(event))) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    if (isChunkRunEvent(event)) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    if (event.type === 'llm/retry') {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') throw new Error('assistant-step start requires step/start')
    return initialState(match.event.data.turn, match.event.data.step)
  },
  update: (context, match) => {
    if (isChunkRunEvent(match.event)) {
      return updateChunkRun(context.state, match.event)
    }
    if (match.event.type === 'assistant/chunk') return updateChunk(context.state, match)
    if (match.event.type === 'assistant/message') {
      return settle(context.state, match, match.event.data.usage)
    }
    if (match.event.type === 'llm/retry') {
      return resetForRetry(context.state)
    }
    return context.state
  },
  publication: assistantStepPublication,
  buildLocationData: (context, scope) => {
    if (scope !== 'step') return null
    const projected = projectAssistant(context)
    if (projected === undefined) return null
    return {
      kind: 'step',
      turn: projected.data.turn,
      step: projected.data.step,
      key: 'assistant-step',
      value: projected.data,
    }
  },
  buildViewNode: (context) => {
    const projected = projectAssistant(context)
    if (projected === undefined) return null
    if (projected.settled === undefined && !projected.visible) {
      const state = context.state ?? fallbackState(context)
      if (state === undefined) return null
      const current = context.current.get('chat')
      if (!state.hidden || current === undefined || current === null) return null
    }
    return chatNode(context, 'assistant-step', projected.anchorSeq, projected.data, {
      visibility: projected.settled?.interrupted === true || projected.visible ? 'visible' : 'hidden',
    })
  },
}

/**
 * Register the Assistant lifecycle business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerAssistantConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(assistantDefinition)
}
