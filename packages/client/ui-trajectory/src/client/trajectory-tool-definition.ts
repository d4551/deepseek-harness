import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
  ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  MAX_TOOL_CALL_DEPTH, acceptsSubcallEdge, childToolCall, childToolResult, SYNTHETIC_SEQ_OFFSETS,
  closedLocationBoundary, interruptedToolResult, rootToolCall, rootToolResult, toolCallMatch,
  type SubcallGraph,
} from '@deepseek-ai/dsh-client-ui-projection'
import type {} from '@deepseek-ai/dsh-tools/types'
import { trajectoryNode } from './trajectory-definition-common.ts'

/**
 * Trajectory stores the call graph as an id-keyed table plus adjacency lists,
 * so a ledger row can look one call up without walking the tree. Chat stores
 * the same graph as nested blocks and memoizes each projection for referential
 * stability. Sharing the state would force one of those access patterns on the
 * other target; the record builders and the edge rule are shared instead.
 */
interface ToolState {
  readonly rootId: string
  readonly calls: ReadonlyMap<string, ToolCallBlock>
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly parents: ReadonlyMap<string, string>
}

/** The call graph {@link acceptsSubcallEdge} walks over Trajectory's id-valued children. */
function subcallGraph(state: ToolState): SubcallGraph {
  return {
    parents: state.parents,
    childIds: callId => state.children.get(callId) ?? [],
  }
}

function updateDispatch(state: ToolState, match: ConversationMatch): ToolState {
  const event = match.event
  if (event.type !== 'tool/code-dispatch-start' && event.type !== 'tool/code-dispatch') return state
  const data = event.data
  const parentId = String(data.parentCallId)
  const childId = String(data.subCallId)
  const siblings = state.children.get(parentId) ?? []
  const index = siblings.indexOf(childId)
  if (index < 0 && !acceptsSubcallEdge(subcallGraph(state), parentId, childId)) return state
  if (event.type === 'tool/code-dispatch-start' && index >= 0) return state

  const calls = new Map(state.calls)
  const previous = calls.get(childId)
  calls.set(childId, event.type === 'tool/code-dispatch-start'
    ? childToolCall(match, data)
    : childToolResult(
      match,
      data,
      previous === undefined || 'kind' in previous ? null : previous.time,
    ))
  if (index >= 0) return { ...state, calls }
  const children = new Map(state.children)
  children.set(parentId, [...siblings, childId])
  const parents = new Map(state.parents)
  parents.set(childId, parentId)
  return { ...state, calls, children, parents }
}

function projectCall(
  state: ToolState,
  callId: string,
  interruptedAt: { seq: number; time: number } | undefined,
  visited = new Set<string>(),
  depth = 1,
): ToolCallBlock | undefined {
  const block = state.calls.get(callId)
  if (block === undefined) return undefined
  if (visited.has(callId) || depth > MAX_TOOL_CALL_DEPTH) return { ...block, subCalls: [] }
  const nextVisited = new Set(visited)
  nextVisited.add(callId)
  const subCalls = (state.children.get(callId) ?? [])
    .flatMap((childId) => {
      const child = projectCall(state, childId, interruptedAt, nextVisited, depth + 1)
      return child === undefined ? [] : [child]
    })
  if ('kind' in block || interruptedAt === undefined) return { ...block, subCalls }
  return interruptedToolResult(
    block,
    interruptedAt,
    interruptedAt.seq + SYNTHETIC_SEQ_OFFSETS.interruptedFollowup,
    subCalls,
  )
}

function fallbackState(context: ConversationNodeContext<ToolState>): ToolState | undefined {
  const resultMatch = context.matches.find(match => match.event.type === 'tool/result')
  const root = resultMatch === undefined ? undefined : rootToolResult(resultMatch)
  if (root === undefined) return undefined
  let state: ToolState = {
    rootId: root.callId,
    calls: new Map([[root.callId, root]]),
    children: new Map(),
    parents: new Map(),
  }
  for (const match of context.matches) state = updateDispatch(state, match)
  return state
}

/** Trajectory-owned root Tool lifecycle with nested Code Dispatch calls. */
const trajectoryToolDefinition: ConversationNodeDefinition<ToolState> = {
  kind: 'trajectory-tool-call',
  target: 'trajectory',
  // The ledger reports every logged result, replacements included.
  match: event => toolCallMatch(event, () => true),
  start: (_context, match) => {
    const root = rootToolCall(match, 'trajectory-tool-call')
    return {
      rootId: root.callId,
      calls: new Map([[root.callId, root]]),
      children: new Map(),
      parents: new Map(),
    }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/result') return updateDispatch(context.state, match)
    const previous = context.state.calls.get(context.state.rootId)
    const running = previous !== undefined && !('kind' in previous) ? previous : undefined
    const result = rootToolResult(match, running)
    if (result === undefined) return context.state
    const calls = new Map(context.state.calls)
    calls.set(context.state.rootId, result)
    return { ...context.state, calls }
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state === undefined) return null
    const root = projectCall(state, state.rootId, closedLocationBoundary(context.start?.location))
    if (root === undefined) return null
    const anchorSeq = context.start?.event.seq
      ?? ('kind' in root ? root.seq : context.matches[0]?.event.seq ?? 0)
    return trajectoryNode(context, anchorSeq, { kind: 'tool', root })
  },
}

/**
 * Register the Trajectory Tool lifecycle.
 *
 * @param ctx - Plugin context receiving the Definition.
 */
export function registerTrajectoryToolDefinition(ctx: Context): void {
  ctx.uiConversation.events.register(trajectoryToolDefinition)
}
