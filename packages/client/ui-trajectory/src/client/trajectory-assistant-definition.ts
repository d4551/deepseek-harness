import type { Context } from '@deepseek-ai/cordis'
import type { ChunkRowEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  AssistantMessageNode, ConversationMatch, ConversationNodeContext,
  ConversationNodeDefinition, PartialAssistant, RequestView,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  EMPTY_ASSISTANT_STREAM, applyAssistantChunk, applyChunkRun, assistantFinalNode,
  assistantStepPublication, closedLocationBoundary, compactBlocks, displayFailure,
  isChunkRunEvent, settledBlocks, type AssistantStream,
} from '@deepseek-ai/dsh-client-ui-projection'
import { trajectoryNode } from './trajectory-definition-common.ts'

interface UsageValue {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

interface RetryValue {
  readonly message: string
  readonly code?: string
  readonly retry: number
  readonly maxRetries?: number
  readonly delayMs: number
}

/**
 * Trajectory's Assistant step state. Beyond the shared block accumulation
 * Trajectory keeps the request lifecycle a ledger row reports: where the step
 * started, whether any chunk arrived, cumulative usage across retries, the
 * pending retry, and the step/end that closes the request.
 */
interface AssistantState {
  readonly turn: number
  readonly step: number
  readonly startSeq: number
  readonly startTime: number
  readonly started: boolean
  readonly sawChunk: boolean
  readonly stream: AssistantStream
  readonly final: ConversationMatch | undefined
  readonly usage: UsageValue | undefined
  readonly retry: RetryValue | undefined
  readonly stepEnd: ConversationMatch | undefined
}

function initialState(
  turn: number,
  step: number,
  startSeq: number,
  startTime: number,
  started: boolean,
): AssistantState {
  return {
    turn,
    step,
    startSeq,
    startTime,
    started,
    sawChunk: false,
    stream: EMPTY_ASSISTANT_STREAM,
    final: undefined,
    usage: undefined,
    retry: undefined,
    stepEnd: undefined,
  }
}

function addUsage(current: UsageValue | undefined, next: UsageValue): UsageValue {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    ...(current?.cacheReadTokens === undefined && next.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) }),
    ...(current?.cacheWriteTokens === undefined && next.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0) }),
    ...(current?.reasoningTokens === undefined && next.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: (current?.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }),
  }
}

function updateChunk(state: AssistantState, match: ConversationMatch): AssistantState {
  if (match.event.type !== 'assistant/chunk') return state
  const chunk = match.event.data.chunk
  if (chunk.type === 'usage') {
    return { ...state, sawChunk: true, usage: addUsage(state.usage, chunk.usage) }
  }
  const stream = applyAssistantChunk(state.stream, chunk, match.event.seq, match.event.time)
  return stream === null ? { ...state, sawChunk: true } : { ...state, sawChunk: true, stream }
}

function updateChunkRun(state: AssistantState, event: ChunkRowEvent): AssistantState {
  return { ...state, sawChunk: true, stream: applyChunkRun(state.stream, event) }
}

function settle(
  state: AssistantState,
  match: ConversationMatch,
  usage: UsageValue | undefined,
): AssistantState {
  if (match.event.type !== 'assistant/message') return state
  const { blocks, visibleBlocks } = settledBlocks(match.event.data.message.content)
  return {
    ...state,
    stream: { ...state.stream, blocks, visibleBlocks },
    final: match,
    usage: state.usage ?? usage,
  }
}

/**
 * Closing seq/time of the request. A step/end this Context already matched
 * closes it even while the Location index still reports the step open.
 */
function closedBoundary(
  context: ConversationNodeContext<AssistantState>,
): { seq: number; time: number } | undefined {
  if (context.state?.stepEnd?.event.type === 'step/end') return context.state.stepEnd.event
  return closedLocationBoundary(context.start?.location ?? context.matches.at(-1)?.location)
}

function fallbackState(context: ConversationNodeContext<AssistantState>): AssistantState | undefined {
  let state: AssistantState | undefined
  for (const match of context.matches) {
    const event = match.event
    if (isChunkRunEvent(event)) {
      state ??= initialState(event.data.turn, event.data.step, event.seq, event.time, false)
      state = updateChunkRun(state, event)
    } else if (event.type === 'assistant/chunk') {
      state ??= initialState(event.data.turn, event.data.step, event.seq, event.time, false)
      state = updateChunk(state, match)
    } else if (event.type === 'assistant/message') {
      state ??= initialState(event.data.turn, event.data.step, event.seq, event.time, false)
      state = settle(state, match, event.data.usage)
    } else if (event.type === 'step/end' && state !== undefined) {
      state = { ...state, stepEnd: match }
    }
  }
  return state
}

function finalNode(
  state: AssistantState,
  context: ConversationNodeContext<AssistantState>,
): AssistantMessageNode | undefined {
  // The ledger times a request from the step/start this Context recorded, and
  // reports which provider and model answered it.
  return assistantFinalNode(
    state,
    {
      stepStartTime: state.started ? state.startTime : null,
      withProvenance: true,
    },
    closedBoundary(context),
  )
}

function assistantRequest(
  state: AssistantState,
  node: AssistantMessageNode | undefined,
  boundary: { seq: number; time: number } | undefined,
): Extract<RequestView, { purpose: 'assistant' }> | undefined {
  if (!state.started) return undefined
  const status = node !== undefined && node.interrupted !== true
    ? 'complete'
    : state.retry !== undefined || boundary !== undefined ? 'error' : 'running'
  return {
    purpose: 'assistant',
    startSeq: state.startSeq,
    turn: state.turn,
    step: state.step,
    startedAt: state.startTime,
    completedAt: node?.time ?? boundary?.time ?? null,
    status,
    ...(state.retry === undefined
      ? {}
      : {
        error: state.retry.message,
        ...(state.retry.code === undefined ? {} : { errorCode: state.retry.code }),
        retry: state.retry.retry,
        ...(state.retry.maxRetries === undefined ? {} : { maxRetries: state.retry.maxRetries }),
        retryDelayMs: state.retry.delayMs,
      }),
    ...(node?.messageId === undefined
      ? {}
      : {
        resultSeq: node.seq,
        ...(node.provenance === undefined ? {} : { provenance: node.provenance }),
      }),
    ...(state.usage === undefined ? {} : { usage: state.usage }),
  }
}

/** Trajectory-owned Assistant streaming, settlement, and request lifecycle. */
const trajectoryAssistantDefinition: ConversationNodeDefinition<AssistantState> = {
  kind: 'trajectory-assistant-step',
  target: 'trajectory',
  match: (event) => {
    if (event.type === 'step/start') {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'start' }
    }
    if (event.type === 'assistant/chunk'
      || event.type === 'assistant/message'
      || event.type === 'llm/retry'
      || event.type === 'step/end') {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    if (isChunkRunEvent(event)) {
      return { id: `${event.data.turn}:${event.data.step}`, role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') {
      throw new Error('trajectory-assistant-step start requires step/start')
    }
    return initialState(
      match.event.data.turn,
      match.event.data.step,
      match.event.seq,
      match.event.time,
      true,
    )
  },
  update: (context, match) => {
    if (isChunkRunEvent(match.event)) return updateChunkRun(context.state, match.event)
    if (match.event.type === 'assistant/chunk') return updateChunk(context.state, match)
    if (match.event.type === 'assistant/message') {
      return settle(context.state, match, match.event.data.usage)
    }
    if (match.event.type === 'step/end') return { ...context.state, stepEnd: match }
    if (match.event.type !== 'llm/retry') return context.state
    const data = match.event.data
    const failure = displayFailure(data.failure)
    return {
      ...initialState(
        context.state.turn,
        context.state.step,
        context.state.startSeq,
        context.state.startTime,
        true,
      ),
      stream: { ...EMPTY_ASSISTANT_STREAM, firstTokenTime: context.state.stream.firstTokenTime },
      usage: context.state.usage,
      retry: {
        message: failure.message,
        ...(failure.code === undefined ? {} : { code: failure.code }),
        retry: data.retry,
        ...(data.mode === 'normal' ? { maxRetries: data.maxRetries } : {}),
        delayMs: data.delayMs,
      },
    }
  },
  publication: assistantStepPublication,
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    const node = finalNode(state, context)
    const boundary = closedBoundary(context)
    const partial: PartialAssistant | null = node === undefined && boundary === undefined && state.sawChunk
      ? { turn: state.turn, step: state.step, blocks: compactBlocks(state.stream.blocks) }
      : null
    const request = assistantRequest(state, node, boundary)
    if (node === undefined && partial === null && request === undefined) return null
    return trajectoryNode(context, state.startSeq, {
      kind: 'assistant',
      ...(node === undefined ? {} : { node }),
      partial,
      ...(request === undefined ? {} : { request }),
    })
  },
}

interface TurnEndState {
  readonly turn: number
  readonly seq: number
  readonly time: number
  readonly error?: string
  readonly errorCode?: string
}

const trajectoryTurnEndDefinition: ConversationNodeDefinition<TurnEndState> = {
  kind: 'trajectory-turn-end',
  target: 'trajectory',
  match: event => event.type === 'turn/end'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => {
    if (match.event.type !== 'turn/end') {
      throw new Error('trajectory-turn-end start requires turn/end')
    }
    const reason = match.event.data.reason
    const failure = reason.kind === 'error' ? displayFailure(reason.error) : undefined
    return {
      turn: match.event.data.turn,
      seq: match.event.seq,
      time: match.event.time,
      ...(failure === undefined ? {} : {
        error: failure.message,
        ...(failure.code === undefined ? {} : { errorCode: failure.code }),
      }),
    }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, {
      kind: 'turn-end',
      turn: context.state.turn,
      time: context.state.time,
      ...(context.state.error === undefined ? {} : { error: context.state.error }),
      ...(context.state.errorCode === undefined ? {} : { errorCode: context.state.errorCode }),
    }),
}

/**
 * Register the Trajectory Assistant lifecycle.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryAssistantDefinition(ctx: Context): void {
  ctx.uiConversation.events.register(trajectoryAssistantDefinition)
  ctx.uiConversation.events.register(trajectoryTurnEndDefinition)
}
