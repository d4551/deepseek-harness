# Agent Note: Which "independent projection" claims in the client survived their diffs

Status: implemented

English | [中文](2026-09-03-client-projection-duplication.zh.md)

## Problem

Removing the repository's `jscpd:ignore` markers exposed 24 clones in `packages/client`, spread over four clusters. Each cluster carried prose asserting that the duplication was deliberate: "Chat and Trajectory own independent event-to-view projections", "UI Subagent and UI Workspace independently project their own views", "Approval and Question intentionally own independent pending-settlement lifecycles", and one comment about parallel TypeScript overloads. The comments were suppression markers, not evidence, so each claim was tested against the duplicated lines before anything was extracted.

## Decision

The client bundle purity gate rejects any `@deepseek-ai/` value import that is not a module-table row, so a shared owner had to be a package the consumers can request. `dsh.client.external` is that mechanism: `stripClientSuffix` maps `<pkg>/client` onto the package's own graph row, and `orderByModuleGraph` orders the row before its consumers. Both owners chosen here were already injected by every consumer, so the request adds no new plugin edge and no purity-gate change. Exercising the gate's `resolveId` directly confirms the asymmetry: the four declaring packages resolve `@deepseek-ai/dsh-client-ui-session/client` to null (external), and a non-declaring package still throws.

`@deepseek-ai/dsh-client-ui-session/client` owns `indexSubagentDescendants` (a fold over the Session Controller list it already adapts) and `settlePendingComposer` / `settlePendingInteraction` (it already owns `registerPendingInteraction`).

`@deepseek-ai/dsh-client-ui-conversation/client` owns `src/client/projection/`: `event-projection.ts`, `assistant-stream.ts`, `tool-calls.ts`, and `messages.ts`. It already declares every record type these functions build — `AssistantBlock`, `AssistantMessageNode`, `RunningToolCall`, `ToolResultNode`, `ContextProvenanceView` — so the projection now lives with the records it produces. Sharing `toolCallMatch` required the Code Dispatch event vocabulary, which only `@deepseek-ai/dsh-tools` declares; it is added as a type-only peer dependency, matching the host-plane types the package already imports for `dsh-session`, `dsh-llm`, and `dsh-tool-todo`.

## What the diffs showed

Three of the four claims were false, one was true.

**UI Subagent / UI Workspace — false.** `subagent-lineage.ts` was byte-identical in both packages apart from the owner name in the module doc comment. Both consumers fold the same `SessionListState['byId']` from the same Session Controller. The "independent views" are the two renderers, which were never the duplicated code.

**Approval / User Questions — false.** `settlePendingComposer` was byte-identical, and the two `answer*` functions ran the same publish/await/delegate/cleanup lifecycle around `uiSession.registerPendingInteraction`. The lifecycle is identical; only the pending value's construction and the outcome type differ.

**Chat / Trajectory — false about the walk, true about the view.** `event-projection.ts` and `trajectory-event-projection.ts` had zero divergent lines of logic: the only structural difference was `sessionRecallLabels`, which Chat had and Trajectory did not. The `assistant`, `tool`, `message`, and `inbox` definitions did diverge, but not in the flagged regions — those were the block accumulator, the tool-call record builders, the subcall-edge rule, the inbox fold, and the message classification. Both targets walked the same events and built the same intermediate values, then diverged at view construction. Two further findings fell out of reading those regions: the synthetic seq offsets were a named table in Chat and the same bare numbers (`-0.9`, `-0.8`) in Trajectory, and Chat's `closedBoundary` carried an `end !== undefined` guard that `ConversationLocationIndex` makes unreachable, since it sets `status: 'closed'` exactly when `end !== undefined`.

**`ui-slots` register overloads — true, and now measured.** The two overloads repeat one type-parameter list because TypeScript cannot share one. Folding them into `I extends object = object` with an optional `inject` typechecks across all 44 client packages, and that is the trap: it turns seven `@ts-expect-error` sites into unused directives (`ui-slots/tests/type-chain.client.spec.tsx` lines 204, 208, 216, 222, 243, 250, and one in `ui-conversation/tests/views-type-chain.client.spec.tsx`). Inferring `I` from an absent `inject` widens the component constraint enough to admit mismatched renderSlot keys, mismatched store shares, a drifting select return, and a missing business face. The nine duplicated lines stay, and the site comment now records that measurement instead of asserting it.

## What each target still owns

The divergence that remains is real and is stated at each site. Chat keeps `hidden`, the retry-suppression flag that keeps a step mounted after a retry discards its visible content, and stores the call graph as nested blocks with a `WeakMap` memo for referential stability. Trajectory keeps the request lifecycle a ledger row reports — `startSeq`, `started`, `sawChunk`, cumulative usage across retries, the pending retry, the closing `step/end` — and stores the call graph as an id-keyed table with adjacency lists so a row can look one call up without walking the tree. Chat accepts only append-surface `tool/result` events, because a replaced result belongs to shadowed history; the ledger accepts every logged result. Chat times a step from the matched `step/start` event and presents no provider identity; Trajectory times from the start it recorded and reports which provider and model answered.

`applyAssistantChunk` returns `null` rather than a state for a chunk that changes no block. That is what lets Chat record `usage` verbatim and Trajectory accumulate it across retries while both share one accumulator.

## Coverage

Both sides of the Chat/Trajectory duplication already sat under GUI-debt coverage exemptions (`packages/client/ui-chat/src/client/conversation-nodes/*` and `packages/client/ui-trajectory/src/*`; vitest expands a trailing `*` recursively), and `packages/client/ui-conversation/src/client/*` covers the new `projection/` directory the same way, so the gate's measured set is unchanged. The extraction made the logic directly testable, so it is now directly tested: with those exemptions overridden, all four projection modules reach 100% on statements, branches, functions, and lines. Logic that had no owner and no direct test now has both.

## Alternatives considered

**Add an `INLINE_SAFE` entry for each new owner.** That allowlist is anchored per subpath and exists for wire layers a browser bundle inlines. `dsh.client.external` is the mechanism for a package a consumer already requests, and every consumer here already injected both owners, so the request adds no plugin edge and the purity gate needs no change. Exercising the gate's `resolveId` directly confirms the asymmetry: the four declaring packages resolve the owner subpath to null, and a non-declaring package still throws.

**Fold the `ui-slots` register overloads.** It typechecks across all 44 client packages, which is what makes it a trap: it turns seven `@ts-expect-error` sites into unused directives, because inferring `I` from an absent `inject` widens the component constraint enough to admit mismatched renderSlot keys, mismatched store shares, a drifting select return, and a missing business face. Nine duplicated lines are cheaper than that surface.

**Extract the Chat and Trajectory view construction as well as the walk.** The two views are genuinely different contracts — one stores the call graph as nested blocks for rendering, the other as an id-keyed table so a ledger row can look one call up without walking the tree — and coupling them would make one surface's rendering decisions constrain the other's. Only the shared walk moved.

## Consequences

24 clones become 1. Six packages lose a copy each; `ui-conversation` and `ui-session` gain one owner each. Exports that no consumer outside `ui-conversation` names are not re-exported from its `./client` boundary, so the published surface grew only by what Chat and Trajectory actually import.

The remaining clone is the `ui-slots` overload pair, kept deliberately with the measurement above recorded at the site.
