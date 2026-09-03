# Agent Note: Shared Client folds and pending settlement

Status: implemented

English | [中文](2026-09-03-shared-client-folds-and-pending-settlement.zh.md)

## Problem

Two Conversation targets projected the same durable Session data twice. `ui-chat/src/client/conversation-nodes/event-projection.ts` and `ui-trajectory/src/client/trajectory-event-projection.ts` were the same walk from a logged `user/message`, `assistant/chunk`, or `tool/call` to the view record a transcript row renders; the Tool-call builders, the Assistant block accumulation, and the inbox splice were duplicated inside their node definitions. `ui-subagent` and `ui-workspace` each carried a copy of the subagent descendant fold, and `ui-approval` and `ui-user-questions` each carried the pending-interaction publish/await/delegate lifecycle around `uiSession.registerPendingInteraction`, both under `jscpd:ignore` markers that said so.

Deduplication is the right instinct. The first landing hoisted the folds into `ui-conversation` and `ui-session` and added `dsh.client.external` rows so the copies could resolve, which put six client feature packages in violation of the rule [`packages/client/AGENTS.md`](../../../../packages/client/AGENTS.md) states and [`verify-client-packages`](../../../../scripts/verify-client-packages.ts) enforces: a feature plugin must not runtime-import another feature plugin's values, and `dsh.client.external` is not a feature-plugin dependency mechanism. The reason is the browser module graph — a cross-row value request has to be answered by the module table, which makes plugin load order and row cycles load-bearing between packages that should only share declarations.

## Decision

The seven shared values split by what they are, not by where they came from.

**Pure folds go to a statically linked, shell-seeded package.** [`packages/client/ui-projection`](../../../../packages/client/ui-projection/README.md) (`@deepseek-ai/dsh-client-ui-projection`) owns `event-projection.ts`, `assistant-stream.ts`, `messages.ts`, `tool-calls.ts`, `subagent-lineage.ts`, and `pending-composer.ts`. Every export is a stateless function or a frozen constant: `contextProvenance`, `sessionRecallLabels`, `toAssistantBlocks`, `displayFailure`, `SYNTHETIC_SEQ_OFFSETS`, `indexSubagentDescendants`, `settlePendingComposer`, and their siblings read only arguments the caller already holds. Nothing compares one of these values by identity, so a duplicate copy would be a correctness no-op and only a bundle-size cost — but the package is a `PLATFORM_MODULES` word anyway, so `apps/web` links one copy and the shell seeds it into the frozen module table for every dynamic bundle. That is the channel `client/store`, `ui-slots`, and `ui-primitives` already use; the gate then rejects a consumer that repeats a baseline module in `dsh.client.external`, and the consumer declares the package only in `devDependencies`.

**The one lifecycle goes to the service that owns it.** `settlePendingInteraction` is not a fold. Its steps — publish into the domain, await the presentation's result, resume the Host waterfall when the rejection is the delegation marker, remove the publication in every outcome, and release the teardown's `completed` gate so `registerPendingInteraction`'s effect can finish disposing — are the `UiSession` publication contract, not the consumer's. `registerPendingInteraction` now returns a `PendingInteractionSettler` instead of a raw `PendingInteractionPublisher`, so publication and settlement are one operation with one settlement point, and `ui-approval` and `ui-user-questions` each shrank to `settle(pending, next)`. The domain's `active` re-entry guard went with it: the settler removes exactly once, in its `finally`, and a value already taken by teardown's `release()` is caught by the `values.delete` result.

The static package takes no runtime dependency on any Client row. It reads `AssistantBlock`, `ConversationMatch`, and their siblings from `@deepseek-ai/dsh-client-ui-conversation/client` with `import type` only, so the edge is erased before emit and only the tsconfig reference records it. `ui-conversation` no longer re-exports the folds — it never called them, and forwarding them was what made it look like their owner.

## Alternatives considered

**Delete the `dsh.client.external` rows and let each consumer inline `ui-conversation/client`.** The bundle-purity plugin rejects it outright, and even if it did not, inlining a dynamic row's entry copies the `ConversationController` and `UiConversation` service classes into a feature bundle. That is not a duplicated fold; it is a duplicated owner.

**Put the folds on the `uiConversation` and `uiSession` services.** The gate's own diagnostic suggests an injected service, and it is right for `settlePendingInteraction`. It is wrong for roughly twenty-five pure functions: a service method per fold makes the Service Definition a namespace, and [`packages/AGENTS.md`](../../../../packages/AGENTS.md) reserves service methods for behavior the service owns. `settlePendingComposer` also has no ctx at its call site — the composer's React handler calls `pending.answer(...)` on the presentation object.

**Move the Conversation contract types into the shared package too, so the type edge points downward.** `contract/records.ts` and `contract/conversation.ts` declare the merge-extensible `ConversationTurnDataMap`, `ConversationStepDataMap`, and `ConversationViewSnapshotMap` that `ui-chat`, `ui-tool`, and others augment through `declare module '@deepseek-ai/dsh-client-ui-conversation/client'`. Moving them relocates every augmentation target across a dozen packages to buy a type-graph direction that is erased at emit. The README records the inversion instead.

**Add the package to the bundle preset's `INLINE_SAFE` list rather than to `PLATFORM_MODULES`.** `INLINE_SAFE` describes exactly this kind of value, so a private copy per bundle would work. It also edits the purity gate's own definition of safety to admit a new package, and it gives up the single-instance guarantee for free bytes in a dozen bundles. Seeding costs three lines in `platform.ts`, `seed.ts`, and the seed spec, and the gate then checks both halves.

**Revert `settlePendingComposer` to a private function in each composer package.** That is what `HEAD` had, under a `jscpd:ignore` marker in both packages. Re-adding a suppression to restore a copy is the move the detector exists to prevent.

## Testing

`packages/client/ui-projection/tests` carries the moved fold suites plus a direct `settlePendingComposer` spec and the invariant-companion spec; the package is at the repository's per-file 100% coverage.

`ui-session.client.spec.ts` pins the single-owner property the service route buys. Two domains registered on one `UiSession` publish into one `pendingInteractions` snapshot and the higher-precedence entry wins, so the composer takeover shows one row. The same test then builds a second owner on its own Cordis root — what a duplicated registry would be — and shows each copy seeing only its own domain, so the shell's single `sessionPendingInteraction` root hook strands the other. Cordis refuses a second `uiSession` on one Context, which is why the duplicate needs a separate root at all.

`ui-trajectory/tests/client-bundle.client.spec.ts` reads the real tsdown artifact: its module table lost `@deepseek-ai/dsh-client-ui-conversation/client` and gained `@deepseek-ai/dsh-client-ui-projection`, which is the module-graph change stated in bytes rather than in a manifest.

## Consequences

Six feature packages stopped requesting a cross-row runtime module, and the browser module table gained one more shell-seeded word instead. A fold now has one owner, so a change to the Assistant block walk reaches Chat and Trajectory together.

The cost is that adding an export to `ui-projection` is a shell change: the name is only reachable once `PLATFORM_MODULES` and `packages/client/web/src/seed.ts` carry the package. The membership rule is narrow on purpose — module state, a Cordis API, or a value a caller compares by identity disqualifies an export, because the seeded table is the only thing making one instance true.

`registerPendingInteraction`'s return type changed, so a future pending-interaction domain gets the settled lifecycle rather than a publisher it must drive correctly. The two composer packages' test benches now fake a settler instead of a publisher.

## Related

[Shared Client row primitives](2026-09-03-shared-client-row-primitives.md) removes the same kind of duplication one layer up, in CSS and React components, through `ui-primitives`.
