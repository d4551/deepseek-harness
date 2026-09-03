/**
 * Published browser entry: pure projections from durable Session data to
 * Client view values, plus the composer settlement adapter. Every export is a
 * stateless function or frozen constant, which is what lets the shell link one
 * copy statically and seed it into the module table for every Client row.
 */

export {
  contextForm, contextProvenance, displayFailure, emptyAssistantBlock, isTokenDelta,
  sessionRecallLabels, toAssistantBlock, toAssistantBlocks,
} from './event-projection.ts'
export type { DisplayFailure } from './event-projection.ts'
export {
  EMPTY_ASSISTANT_STREAM, SYNTHETIC_SEQ_OFFSETS, applyAssistantChunk, applyChunkRun,
  assistantFinalNode, assistantStepPublication, blockIsVisible, closedLocationBoundary,
  compactBlocks, isChunkRunEvent, settledBlocks,
} from './assistant-stream.ts'
export type { AssistantStream } from './assistant-stream.ts'
export { applyInboxSplice, inputMessageNode } from './messages.ts'
export type { InboxState, InputMessageNode } from './messages.ts'
export {
  MAX_TOOL_CALL_DEPTH, acceptsSubcallEdge, childToolCall, childToolResult,
  interruptedToolResult, rootToolCall, rootToolResult, toolCallMatch,
} from './tool-calls.ts'
export type { SubcallGraph } from './tool-calls.ts'
export { indexSubagentDescendants } from './subagent-lineage.ts'
export type { SubagentDescendantSummary } from './subagent-lineage.ts'
export { settlePendingComposer } from './pending-composer.ts'
