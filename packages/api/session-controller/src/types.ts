/** Browser-safe request, result, and lifecycle vocabulary for the Session Remote service. */

import type {
  AttachmentIdType, ImageAttachmentLimits, ImageAttachmentRef, ImageMediaType,
} from '@deepseek-ai/dsh-attachment'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ChunkRow } from '@deepseek-ai/dsh-session/chunk-rows'
import type { JsonValue, SessionHeader, SessionId, SurfaceOp } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host state persisted for cold Session list summaries. */
    sessionListMetadata: SessionListMetadata
    /** Host state for the boot-constant image-limit view. */
    imageLimits: null
    /** Durable model selection already used by a request and still pending for a later request. */
    modelSelection: ModelSelectionProjectionState
    /** The Session's primary root and the additional roots its log records. */
    workspaceRoots: WorkspaceRootsProjection
  }
  interface SessionProjectionMap {
    /** Persisted facts used to summarize a Session without activating it. */
    sessionListMetadata: SessionListMetadata
    /** Image-intake limits enforced by the Session prompt endpoint. */
    imageLimits: ImageAttachmentLimits
    /** Durable model selection already used and selected for the next request. */
    modelSelection: ModelSelectionProjection
    /** Every workspace root the Session works in; see {@link WorkspaceRootsProjection}. */
    workspaceRoots: WorkspaceRootsProjection
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete validated model selection requested for subsequent prompt
     * assembly. Log-only: it never enters derived model history.
     */
    'model/selection': ModelSelection
  }
}

/** Persisted hints used to summarize a cold Session. */
export interface SessionListMetadata {
  /** Whether the folded prefix contains no turn. */
  readonly blank: boolean
  /** Latest human-authored prompt time in the folded prefix. */
  readonly lastPromptAt: number | null
}

/** Every available cached wire value used as partial, possibly stale Session-list hints. */
export interface SessionProjectionHints {
  readonly asOfSeq: number
  /** Provider-validated values present in the cache; omitted keys remain unknown. */
  readonly values: SessionProjectionValues
}

/** Complete projection values at an exact Session event cursor. */
export interface SessionProjectionBaseline {
  readonly asOfSeq: number
  /** Provider-validated values; omitted keys are absent capabilities at this cut. */
  readonly values: SessionProjectionValues
}

/** Typed known projections plus JSON-safe values contributed outside this compilation face. */
export type SessionProjectionValues = Partial<SessionProjectionMap>
  & Readonly<Record<string, SessionProjectionValue>>

/** Browser-submitted prompt content; the Host promotes image bytes to durable references. */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'image'
    readonly mediaType: ImageMediaType
    readonly data: string
    readonly name?: string
  }

/** Complete model selection for one Session. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Host fold state for durable model selection. */
export interface ModelSelectionProjectionState {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Later user selection not yet consumed by a matching model request. */
  readonly pending: ModelSelection | null
}

/** Client view of the durable model-selection fold. */
export interface ModelSelectionProjection {
  /** Selection consumed by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Selection the next request should use, falling back to {@link lastUsed}. */
  readonly next: ModelSelection | null
}

/**
 * Every workspace root one Session works in. `primary` is the immutable
 * {@link SessionHeader.cwd} the Session was created against — null for a
 * Session created without one — and `additional` folds the Session's
 * `workspace/roots` log, so the pair is exactly what search coverage,
 * language-server routing, per-root instruction loading, and the sandbox
 * write fence resolve from. Both the state and the wire view are this one
 * record: nothing is derived on the client.
 */
export interface WorkspaceRootsProjection {
  /** The Session's immutable primary root; null when it was created without a cwd. */
  readonly primary: string | null
  /** Additional roots the Session recorded, in the order the last `workspace/roots` event carries. */
  readonly additional: readonly string[]
}

/** Session-addressed request replacing the complete additional-root set. */
export interface SessionSetWorkspaceRootsRequest {
  readonly sessionId: SessionId
  /**
   * The complete replacement set of additional absolute roots. An empty list
   * records that the Session works in its primary root alone; the Session's own
   * primary root and duplicate spellings are dropped rather than rejected,
   * matching `setAdditionalWorkspaceRoots`.
   */
  readonly additionalDirectories: readonly string[]
}

/** The additional-root set the Session carries after the replacement committed. */
export interface SessionSetWorkspaceRootsValue {
  readonly additional: readonly string[]
}

/**
 * Where this deployment's composed filesystem backend keeps the workspace: the
 * wire face of `ctx.fs.origin`. It is a deployment fact, not a Session one —
 * the harness runs one filesystem provider — so a surface reads it once and
 * applies it to every Session's primary root.
 */
export interface SessionWorkspaceOrigin {
  /**
   * The backend's declared origin, as `FsOrigin.kind` states it. The
   * filesystem origin vocabulary is merge-extensible, so this crosses the wire
   * as a plain string and a surface names an unrecognized member rather than
   * claiming one it knows.
   */
  readonly kind: string
}

/** One adapter-owned reasoning effort for an exact model route. */
export interface ModelReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Selectable reasoning metadata for one exact model route. */
export interface ModelReasoning {
  readonly efforts: readonly ModelReasoningEffort[]
  readonly defaultEffort?: string
}

/** One model displayed inside its provider group. */
export interface ModelCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: ModelReasoning
}

/** One provider and its successfully loaded model catalog. */
export interface ModelProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelCatalogModel[]
  /**
   * Where this route's models run, as the adapter states it (`LlmProviderInfo.hosting`).
   * Absent means the adapter draws no such distinction, so a selector labels
   * nothing rather than guessing at a cloud API's hardware.
   */
  readonly hosting?: 'local' | 'self-hosted'
}

/** One provider whose model catalog lookup failed. */
export interface ModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** Host-generation model catalog and the default used by unconfigured Sessions. */
export interface ModelCatalog {
  readonly default: ModelSelection
  /** Provider routes currently able to serve a request, including empty catalogs. */
  readonly routableProviders: readonly string[]
  readonly groups: readonly ModelProviderGroup[]
  readonly failures: readonly ModelCatalogFailure[]
}

/** One client-requested mutation of a still-pending queue item. */
export type QueueAction =
  | { readonly kind: 'edit'; readonly content: readonly ContentBlock[] }
  | { readonly kind: 'remove' }
  | { readonly kind: 'steer' }

/** One Session list entry. */
export interface SessionSummary {
  readonly sessionId: SessionId
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly parentSessionId?: SessionId
  readonly origin?: 'subagent'
  readonly cwd?: string
  readonly projections?: SessionProjectionHints
}

/** One session-content search result. */
export interface SessionSearchItem {
  readonly sessionId: SessionId
  readonly snippet: string
}

/** Maximum number of Sessions returned by one search. */
export const SESSION_SEARCH_RESULT_LIMIT = 20

/** Maximum search snippet length in Unicode code points. */
export const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240

/** Error details returned by Session Remote methods. */
export interface SessionErrorDetailsMap {
  'bad-request': Record<never, never>
  cancelled: Record<never, never>
  'session-not-found': { readonly sessionId: SessionId }
  'model-unavailable': { readonly provider: string; readonly model: string }
  'session-conflict': {
    readonly sessionId: SessionId
    readonly requestedCwd: string
    readonly existingCwd?: string
  }
  'invalid-time-zone': { readonly value: string }
  'workspace-attach-failed': { readonly sessionId: SessionId; readonly workspaceId: string }
  'workspace-not-found': { readonly workspaceId: string }
  'agent-preset-conflict': {
    readonly sessionId: SessionId
    readonly requestedPreset: string
    readonly existingPreset?: string
  }
  'agent-preset-not-found': { readonly agentPreset: string; readonly available: readonly string[] }
  'agent-preset-invalid': { readonly agentPreset: string; readonly reason: string }
  'agent-busy': { readonly reason: string }
  'attachment-error': { readonly reason: string }
  'queue-item-not-found': { readonly itemId: MessageId }
  'steer-unavailable': { readonly itemId: MessageId }
  'title-invalid': { readonly sessionId: SessionId }
  'fork-unavailable': { readonly sessionId: SessionId }
  'subagent-not-found': {
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
  }
  'subagent-catalog-diagnostic': {
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }
  'subagent-unauthorized': { readonly childSessionId: SessionId }
  internal: Record<never, never>
}

/** Session business failure returned without throwing a carrier error. */
export type SessionError = {
  [Code in keyof SessionErrorDetailsMap]: {
    readonly code: Code
    readonly message: string
    readonly details: SessionErrorDetailsMap[Code]
  }
}[keyof SessionErrorDetailsMap]

/** Session-addressed request for the human-invocable skill catalog. */
export interface SkillListRequest {
  readonly sessionId: SessionId
}

/** One skill available to the Session's human-facing composer. */
export interface SkillEntry {
  /** Kebab-case identifier referenced as `/name`. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Whether the same skill is also advertised to the model. */
  readonly modelInvocable: boolean
}

/** Human-invocable skills visible through one Session's composition. */
export interface SkillListValue {
  readonly skills: readonly SkillEntry[]
}

/** Session list request. */
export interface SessionListRequest {
  readonly cursor?: string
}

/** Session list response value. */
export interface SessionListValue {
  readonly items: readonly SessionSummary[]
}

/** Session search request. */
export interface SessionSearchRequest {
  readonly query: string
}

/** Session search response value. */
export interface SessionSearchValue {
  readonly items: readonly SessionSearchItem[]
  readonly hasMore: boolean
}

/** Session creation or explicit-id adoption request. */
export interface SessionCreateRequest {
  readonly workspaceId?: WorkspaceId
  readonly cwd?: string
  /**
   * Absolute directories the Session may also work in, beside its primary
   * `cwd` — the multi-root workspace model. They become the Session's durable
   * additional workspace roots; omitted or empty means the Session works in
   * its primary root alone.
   */
  readonly additionalDirectories?: readonly string[]
  readonly sessionId?: SessionId
  readonly agentPreset?: string
}

/** Session creation response value. */
export interface SessionCreateValue {
  readonly sessionId: SessionId
  readonly agentPreset?: string
}

/** Session model-selection request. */
export interface SessionSelectModelRequest extends ModelSelection {
  readonly sessionId: SessionId
}

/** Accepted model selection after Host resolution. */
export interface SessionSelectModelValue {
  readonly selected: ModelSelection
}

/** Session rename request. */
export interface SessionRenameRequest {
  readonly sessionId: SessionId
  readonly title: string
}

/** Normalized title and the durable event position that committed it. */
export interface SessionRenameValue {
  readonly title: string
  readonly seq: number
}

/** Session fork request. */
export interface SessionForkRequest {
  readonly sessionId: SessionId
  readonly atSeq?: number
}

/** Identity of a newly forked Session. */
export interface SessionForkValue {
  readonly sessionId: SessionId
}

/** Session prompt request. */
export interface SessionPromptRequest {
  /** Client-minted identity persisted on the exact accepted user message. */
  readonly requestId: SessionRequestId
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}

/** Receipt after one prompt enters the target Agent inbox. */
export interface SessionPromptValue {
  readonly accepted: true
}

/** Durable image read request. */
export interface SessionAttachmentRequest {
  readonly sessionId: SessionId
  readonly attachmentId: AttachmentIdType
}

/** Durable image read response value. */
export interface SessionAttachmentValue {
  readonly attachment: ImageAttachmentRef
  readonly data: string
}

/** Pending queue mutation request. */
export interface SessionUpdateQueueRequest {
  readonly sessionId: SessionId
  readonly itemId: MessageId
  readonly action: QueueAction
}

/** Receipt after one pending queue mutation commits. */
export interface SessionUpdateQueueValue {
  readonly accepted: true
}

/** Active-turn cancellation request. */
export interface SessionCancelRequest {
  readonly sessionId: SessionId
}

/** Receipt after cancellation is admitted to the live Agent. */
export interface SessionCancelValue {
  readonly accepted: true
}

/** Request to open one path prepared by a Session-aware caller on the Host desktop. */
export interface SessionOpenWorkspacePathRequest {
  /** Path after best-effort Session workspace resolution, in Host filesystem syntax. */
  readonly path: string
}

/** Confirmation that the Host handed a workspace path to its native opener. */
export interface SessionOpenWorkspacePathValue {
  readonly opened: true
}

/** Client-minted prompt identity used to reconcile optimistic and durable messages. */
export type SessionRequestId = Branded<'session-request-id'>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Browser prompt correlation and optional Host-validated time zone. */
    'user-rpc': { kind: 'user'; rpcId: SessionRequestId; clientTimeZone?: string }
  }
}

/** Durable identity selecting an ordinary Session or one direct subagent child. */
export type SessionAddress =
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | {
    readonly kind: 'subagent'
    readonly parentSessionId: SessionId
    readonly childSessionId: SessionId
    readonly mode: 'one-shot' | 'continuable'
  }

/** One raw Session event in the Remote journal. */
export interface SessionEventEntry {
  readonly type: 'event'
  readonly event: SessionWireEvent
}

/** Event-shaped wire representation of one packed chunk row. */
export type ChunkRowEvent = {
  [Kind in ChunkRow['type']]: {
    readonly type: `chunkrow/${Kind}`
    readonly seq: number
    readonly time: number
    readonly data: Extract<ChunkRow, { readonly type: Kind }>['data']
  }
}[ChunkRow['type']]

/** One lossless run of consecutive Assistant delta events in a history page. */
export interface SessionChunkRun {
  readonly type: 'chunks'
  readonly event: ChunkRowEvent
}

/** One history-page record: a raw event or a packed Assistant delta run. */
export type SessionHistoryRecord = SessionEventEntry | SessionChunkRun

/** Session event wire form; durable readers own recognition of merge-extensible event names. */
export interface SessionWireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: JsonValue
  readonly sourceEventSeqs?: number[]
  readonly surfaceOp?: SurfaceOp
}

/** One message-aligned backwards-history request. */
export interface SessionPageRequest {
  readonly address: SessionAddress
  /** Inclusive log cut obtained from the corresponding follow opening frame. */
  readonly throughSeq: number
  readonly beforeSeq?: number
  readonly maxMessages?: number
}

/** One live event request for a durable Session address. */
export interface SessionFollowRequest {
  readonly address: SessionAddress
  readonly maxMessages?: number
}

/** One contiguous backwards page of a Session log. */
export interface SessionPage {
  readonly records: readonly SessionHistoryRecord[]
  readonly hasMore: boolean
}

/** Complete opening window followed by ordered events appended after its cursor. */
export type SessionFollowFrame =
  | {
    readonly type: 'snapshot'
    readonly header: SessionHeader
    readonly cursor: number
    readonly records: readonly SessionHistoryRecord[]
    readonly hasMore: boolean
    readonly projections: SessionProjectionBaseline
  }
  | SessionEventEntry

/** One pending inbox occurrence in the authoritative queue snapshot. */
export interface SessionQueuedItem {
  readonly id: MessageId
  readonly placement: 'queued' | 'steering' | 'context'
  /** Prompt-RPC identity from the queued message's user source; clients retire the matching local submission echo on it. */
  readonly rpcId?: SessionRequestId
  /** JSON-safe message fields consumed by pending-queue presentation. */
  readonly message: {
    readonly id: MessageId
    readonly content: readonly JsonValue[]
  }
}

/** Browser-safe background-job row. */
export interface SessionJob {
  readonly id: JobId
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

/** Complete live control baseline emitted once per control stream generation. */
export interface SessionControlBaseline {
  readonly queues: Readonly<Record<SessionId, readonly SessionQueuedItem[]>>
  readonly jobs: Readonly<Record<SessionId, readonly SessionJob[]>>
  readonly projections: Readonly<Record<SessionId, SessionProjectionBaseline>>
}

/** One finished projection value and its durable watermark. */
export interface SessionProjectionUpdate {
  readonly sessionId: SessionId
  readonly key: string
  readonly value: JsonValue
  readonly seq: number
}

/** Host-wide live state stream. Each generation starts with exactly one baseline. */
export type SessionControlFrame =
  | { readonly type: 'baseline'; readonly value: SessionControlBaseline }
  | { readonly type: 'queue'; readonly sessionId: SessionId; readonly items: readonly SessionQueuedItem[] }
  | { readonly type: 'jobs'; readonly sessionId: SessionId; readonly jobs: readonly SessionJob[] }
  | ({ readonly type: 'projection' } & SessionProjectionUpdate)

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A Session became visible to Session list consumers.
     * @mode emit
     * @param summary - initial list row for the Session.
     */
    'api-session/added'(summary: SessionSummary): void
    /**
     * A Session left the live Host registry.
     * @mode emit
     * @param sessionId - removed Session identity.
     */
    'api-session/removed'(sessionId: SessionId): void
    /**
     * One Agent changed running state.
     * @mode emit
     * @param sessionId - Agent and Session identity.
     * @param running - whether the Agent is running.
     */
    'api-session/status'(sessionId: SessionId, running: boolean): void
    /**
     * One user-authored durable message advanced Session list activity.
     * @mode emit
     * @param sessionId - addressed Session identity.
     * @param updatedAt - durable message time used for list ordering.
     */
    'api-session/activity'(sessionId: SessionId, updatedAt: number): void
    /**
     * One Agent failed outside a durable turn position.
     * @mode emit
     * @param sessionId - Agent and Session identity.
     * @param message - user-safe failure chain.
     */
    'api-session/error'(sessionId: SessionId, message: string): void
  }
}

/** JSON-compatible projection value accepted by list consumers. */
export type SessionProjectionValue = JsonValue
