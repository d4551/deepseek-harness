import type { Context } from '@deepseek-ai/cordis'
import {
  MAX_TOOL_CALL_DEPTH, acceptsSubcallEdge, childToolCall, childToolResult,
  SYNTHETIC_SEQ_OFFSETS, closedLocationBoundary, interruptedToolResult, rootToolCall,
  rootToolResult, toolCallMatch,
  type ConversationMatch, type ConversationNodeContext, type ConversationNodeDefinition,
  type SubcallGraph,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { ToolChatData } from '../contract/chat-nodes.ts'
// The declaring package, not the local barrel: a Typert-modeled reference must
// name the package that owns the type so the generated import can point at it.
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Root Tool lifecycle with recursively nested subcalls. */
    'tool-call': ToolChatData
  }
}

interface ToolState {
  readonly root: ToolCallBlock
  readonly children: ReadonlyMap<string, readonly ToolCallBlock[]>
  readonly parents: ReadonlyMap<string, string>
}

interface ProjectedBlockCache {
  readonly children: readonly ToolCallBlock[]
  readonly interruptionSeq: number | undefined
  readonly interruptionTime: number | undefined
  readonly value: ToolCallBlock
}

const projectedBlocks = new WeakMap<ToolCallBlock, ProjectedBlockCache>()

/** The call graph {@link acceptsSubcallEdge} walks over Chat's block-valued children. */
function subcallGraph(state: ToolState): SubcallGraph {
  return {
    parents: state.parents,
    childIds: (callId: string) => (state.children.get(callId) ?? []).map(child => child.callId),
  }
}

function updateDispatch(state: ToolState, match: ConversationMatch): ToolState {
  const event = match.event
  if (event.type !== 'tool/code-dispatch-start' && event.type !== 'tool/code-dispatch') return state
  const data = event.data
  const parentCallId = String(data.parentCallId)
  const subCallId = String(data.subCallId)
  const siblings = state.children.get(parentCallId) ?? []
  const index = siblings.findIndex(candidate => candidate.callId === subCallId)
  if (event.type === 'tool/code-dispatch-start') {
    if (index >= 0 || !acceptsSubcallEdge(subcallGraph(state), parentCallId, subCallId)) return state
    const children = new Map(state.children)
    children.set(parentCallId, [...siblings, childToolCall(match, data)])
    const parents = new Map(state.parents)
    parents.set(subCallId, parentCallId)
    return { ...state, children, parents }
  }
  if (index < 0 && !acceptsSubcallEdge(subcallGraph(state), parentCallId, subCallId)) return state
  const previous = index < 0 ? undefined : siblings[index]
  const settled = childToolResult(match, data, previous?.time ?? null)
  const children = new Map(state.children)
  children.set(parentCallId, index < 0
    ? [...siblings, settled]
    : siblings.map((child, at) => at === index ? settled : child))
  const parents = new Map(state.parents)
  if (index < 0) parents.set(subCallId, parentCallId)
  return { ...state, children, parents }
}

function projectBlock(
  block: ToolCallBlock,
  state: ToolState,
  interruptedAt: { seq: number; time: number } | undefined,
  visited = new Set<string>(),
  depth = 1,
): ToolCallBlock {
  if (visited.has(block.callId) || depth > MAX_TOOL_CALL_DEPTH) return { ...block, subCalls: [] }
  const nextVisited = new Set(visited)
  nextVisited.add(block.callId)
  const children = (state.children.get(block.callId) ?? block.subCalls)
    .map(child => projectBlock(child, state, interruptedAt, nextVisited, depth + 1))
  const interruptionSeq = 'kind' in block ? undefined : interruptedAt?.seq
  const interruptionTime = 'kind' in block ? undefined : interruptedAt?.time
  const cached = projectedBlocks.get(block)
  if (cached !== undefined
    && cached.interruptionSeq === interruptionSeq
    && cached.interruptionTime === interruptionTime
    && sameReferences(cached.children, children)) {
    return cached.value
  }
  const projected: ToolCallBlock = 'kind' in block || interruptedAt === undefined
    ? sameReferences(block.subCalls, children) ? block : { ...block, subCalls: children }
    : interruptedToolResult(
      block,
      interruptedAt,
      interruptedAt.seq + SYNTHETIC_SEQ_OFFSETS.interruptedFollowup,
      children,
    )
  projectedBlocks.set(block, { children, interruptionSeq, interruptionTime, value: projected })
  return projected
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function fallbackState(context: ConversationNodeContext<ToolState>): ToolState | undefined {
  const match = context.matches.find(candidate => candidate.event.type === 'tool/result')
  const root = match === undefined ? undefined : rootToolResult(match)
  if (root === undefined) return undefined
  let state: ToolState = { root, children: new Map(), parents: new Map() }
  for (const candidate of context.matches) state = updateDispatch(state, candidate)
  return state
}

/** Root Tool lifecycle and nested Code Dispatch Definition. */
export const toolDefinition: ConversationNodeDefinition<ToolState> = {
  kind: 'tool-call',
  target: 'chat',
  // Chat renders the flow the model produced: a replaced tool/result belongs to
  // shadowed history and must not re-open its settled row.
  match: event => toolCallMatch(event, isAppendSurfaceEvent),
  start: (_context, match) => ({
    root: rootToolCall(match, 'tool-call'),
    children: new Map(),
    parents: new Map(),
  }),
  update: (context, match) => {
    if (match.event.type === 'tool/result') {
      const running = 'kind' in context.state.root ? undefined : context.state.root
      const result = rootToolResult(match, running)
      return result === undefined ? context.state : { ...context.state, root: result }
    }
    return updateDispatch(context.state, match)
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    const projected = projectBlock(state.root, state, closedLocationBoundary(context.start?.location))
    const anchor = context.start?.event.seq
      ?? ('kind' in state.root ? state.root.seq : context.matches[0]?.event.seq ?? 0)
    return chatNode(context, 'tool-call', anchor, { root: projected } satisfies ToolChatData)
  },
}

/**
 * Register the root Tool lifecycle and nested-subcall contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerToolConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(toolDefinition)
}
