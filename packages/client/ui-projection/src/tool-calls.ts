/**
 * Tool-call record projection shared by every Conversation target: the builders
 * from `tool/call`, `tool/result`, and Code Dispatch events to
 * {@link RunningToolCall} and {@link ToolResultNode}, plus the subcall-graph
 * rule that bounds nesting. Targets keep their own call-graph representation
 * and their own view node; the records and the acceptance rule have one owner.
 * @module @deepseek-ai/dsh-client-ui-projection/src/tool-calls
 */

import type {} from '@deepseek-ai/dsh-tools/types'
import type {
  ConversationMatch, ConversationMatchResult, ConversationNodeDefinition, RunningToolCall,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Maximum ancestor-plus-subtree depth one root call may reach. A durable log
 * can carry a dispatch cycle; the bound keeps the recursive projection finite.
 */
export const MAX_TOOL_CALL_DEPTH = 256

/** One event a root Tool Definition considers. */
type ToolEvent = Parameters<ConversationNodeDefinition['match']>[0]

/**
 * Select the events of one root Tool lifecycle: the opening `tool/call`, its
 * settling `tool/result`, and every Code Dispatch row naming it as root. Every
 * target keys the same Context by the same call id; they differ only in which
 * `tool/result` surfaces they render.
 * @param event - the session event offered to the Definition.
 * @param acceptsResult - the target's `tool/result` surface policy.
 * @returns the Context id and lifecycle role, or null when the event is not
 * part of a root Tool lifecycle.
 */
export function toolCallMatch(
  event: ToolEvent,
  acceptsResult: (event: Extract<ToolEvent, { type: 'tool/result' }>) => boolean,
): ConversationMatchResult | null {
  if (event.type === 'tool/call') return { id: String(event.data.callId), role: 'start' }
  if (event.type === 'tool/result' && acceptsResult(event)) {
    return { id: String(event.data.message.source.callId), role: 'update' }
  }
  if (event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch') {
    const rootCallId: unknown = event.data.rootCallId
    return typeof rootCallId === 'string' && rootCallId !== ''
      ? { id: rootCallId, role: 'update' }
      : null
  }
  return null
}

/** The Code Dispatch fields both a start and a result event carry. */
export interface DispatchData {
  readonly parentCallId: string
  readonly subCallId: string
  readonly name: string
  readonly arguments: unknown
  readonly isError?: boolean
  readonly content?: ToolResultNode['content']
}

/**
 * Build the running root call of one `tool/call` event.
 * @param match - the matched event.
 * @param kind - Definition kind named in the failure message.
 * @returns the running call with no subcalls yet.
 * @throws {Error} when the start match is not a `tool/call`.
 */
export function rootToolCall(match: ConversationMatch, kind: string): RunningToolCall {
  if (match.event.type !== 'tool/call') throw new Error(`${kind} start requires tool/call`)
  return {
    callId: String(match.event.data.callId),
    name: match.event.data.name,
    argsRaw: match.event.data.arguments,
    turn: match.event.data.turn,
    step: match.event.data.step,
    time: match.event.time,
    subCalls: [],
  }
}

/**
 * Build the settled root result of one `tool/result` event.
 * @param match - the matched event.
 * @param previous - the running call this result settles, when still in window.
 * @returns the settled result, or undefined when the match is not a `tool/result`.
 */
export function rootToolResult(
  match: ConversationMatch,
  previous?: RunningToolCall,
): ToolResultNode | undefined {
  if (match.event.type !== 'tool/result') return undefined
  const result = match.event.data.message.content[0]
  return {
    kind: 'tool-result',
    seq: match.event.seq,
    time: match.event.time,
    callId: String(match.event.data.message.source.callId),
    call: previous === undefined ? null : { name: previous.name, argsRaw: previous.argsRaw },
    callTime: previous?.time ?? null,
    content: result.content,
    isError: result.isError === true,
    ...(match.event.data.error === undefined ? {} : { error: match.event.data.error }),
    meta: match.event.data.meta,
    subCalls: [],
  }
}

/**
 * Turn number of a matched event's resolved location.
 * @param match - the matched event.
 * @returns the turn, or 0 when the location resolved no turn.
 */
export function locationTurn(match: ConversationMatch): number {
  return match.location.kind === 'step' || match.location.kind === 'turn'
    ? match.location.turn.turn
    : 0
}

/**
 * Step number of a matched event's resolved location.
 * @param match - the matched event.
 * @returns the step, or 0 when the location resolved no step.
 */
export function locationStep(match: ConversationMatch): number {
  return match.location.kind === 'step' ? match.location.step.step : 0
}

/**
 * Build the running child call of one `tool/code-dispatch-start` event.
 * @param match - the matched event.
 * @param data - the dispatch fields.
 * @returns the running child call with no subcalls yet.
 */
export function childToolCall(match: ConversationMatch, data: DispatchData): RunningToolCall {
  return {
    callId: data.subCallId,
    parentCallId: data.parentCallId,
    name: data.name,
    argsRaw: JSON.stringify(data.arguments),
    turn: locationTurn(match),
    step: locationStep(match),
    time: match.event.time,
    subCalls: [],
  }
}

/**
 * Build the settled child result of one `tool/code-dispatch` event.
 * @param match - the matched event.
 * @param data - the dispatch fields.
 * @param callTime - Unix epoch ms of the paired call, or null when the target
 * treats the previous entry as carrying no usable call time.
 * @returns the settled child result.
 */
export function childToolResult(
  match: ConversationMatch,
  data: DispatchData,
  callTime: number | null,
): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: match.event.seq,
    time: match.event.time,
    callId: data.subCallId,
    parentCallId: data.parentCallId,
    call: { name: data.name, argsRaw: JSON.stringify(data.arguments) },
    callTime,
    content: data.content ?? [],
    isError: data.isError === true,
    subCalls: [],
  }
}

/** The call graph {@link acceptsSubcallEdge} walks, however a target stores it. */
export interface SubcallGraph {
  /** Parent call id of each call that has one. */
  readonly parents: ReadonlyMap<string, string>
  /**
   * Child call ids of one call, in dispatch order.
   * @param callId - the parent call id.
   * @returns its child ids, empty when it has none.
   */
  childIds: (callId: string) => readonly string[]
}

/**
 * Whether one parent/child dispatch edge may join the call graph. Rejects
 * self-parenting, re-parenting, an edge that closes an ancestor cycle, and an
 * edge whose combined ancestor and subtree depth would exceed
 * {@link MAX_TOOL_CALL_DEPTH}.
 * @param graph - the current call graph.
 * @param parent - proposed parent call id.
 * @param child - proposed child call id.
 * @returns whether the edge is accepted.
 */
export function acceptsSubcallEdge(graph: SubcallGraph, parent: string, child: string): boolean {
  if (parent === child || graph.parents.has(child)) return false
  let cursor: string | undefined = parent
  let parentDepth = 0
  const ancestors = new Set<string>()
  while (cursor !== undefined) {
    if (cursor === child || ancestors.has(cursor)) return false
    ancestors.add(cursor)
    parentDepth++
    cursor = graph.parents.get(cursor)
  }
  const pending = [{ callId: child, depth: 1 }]
  const descendants = new Set<string>()
  let subtreeDepth = 0
  for (const candidate of pending) {
    if (descendants.has(candidate.callId)) return false
    descendants.add(candidate.callId)
    subtreeDepth = Math.max(subtreeDepth, candidate.depth)
    for (const nested of graph.childIds(candidate.callId)) {
      pending.push({ callId: nested, depth: candidate.depth + 1 })
    }
  }
  return parentDepth + subtreeDepth <= MAX_TOOL_CALL_DEPTH
}

/**
 * Freeze a running call as an interrupted result at a closing boundary.
 * @param call - the call still running when the step or turn closed.
 * @param boundary - closing seq/time of the step or turn.
 * @param seq - fractional seq ordering the synthetic result inside the flow.
 * @param subCalls - already-projected child calls.
 * @returns the synthetic interrupted result.
 */
export function interruptedToolResult(
  call: RunningToolCall,
  boundary: { seq: number; time: number },
  seq: number,
  subCalls: readonly ToolResultNode['subCalls'][number][],
): ToolResultNode {
  return {
    kind: 'tool-result',
    seq,
    time: boundary.time,
    callId: call.callId,
    ...(call.parentCallId === undefined ? {} : { parentCallId: call.parentCallId }),
    call: { name: call.name, argsRaw: call.argsRaw },
    callTime: call.time,
    content: [],
    isError: true,
    error: { name: 'Interrupted', code: 'interrupted' },
    subCalls,
  }
}
