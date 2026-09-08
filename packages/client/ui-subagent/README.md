---
description: "Subagent conversation catalog, continuation routing UI, and '@' reference source for the dsh web client."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-subagent` is the web client's subagent conversation feature: users browse and open subagent conversations from the parent session's header, continue them through reason-specific read-only composer states, and reference running children with the `@` source. From the parent session's header, users browse the complete subagent-origin descendant lineage — each row shows mode, running activity, token usage, and active-turn duration — and open any depth with the child's exact address. A one-shot child always opens a read-only composer identifying the transcript as a completed execution record; a continuable child routes follow-up prompts through its FIFO inbox while it runs. Subagent-origin Session rows are omitted from the ordinary sidebar, so the parent header catalog is their navigation entry point.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The session header keeps the current session title as the lineage breadcrumb and, when the session has subagent descendants, appends a `/` count trigger before the header's action row; the trigger opens the descendant catalog, counts the complete subagent-only lineage, stops at ordinary forks, and shows ongoing activity when any counted descendant is running. Select any depth to open that child's conversation with its exact `{parentSessionId, childSessionId, mode}` address.

### Browsing the tree

Click or tap the descendant count or current child title to toggle its catalog. Enter and Space activate the focused button; ArrowDown opens the tree and focuses its first available row. Hover also opens the catalog. Rows display mode, `running`/`inactive` activity, an optional log-backed title, durable token usage, and active-turn duration. ArrowRight/ArrowLeft expand and collapse branches; ArrowUp/ArrowDown, Home, End, and Escape navigate or close the tree. Unlabeled one-shot rows display their session ids; corrupt, unsupported, or unavailable rows remain readable but disabled.

### Continuing a conversation

A continuable child with a live parent keeps the ordinary input chrome: typing and Send stay available while the child runs because every follow-up joins the child's FIFO inbox, and an independent Stop routes through `subagents/interruptByParent`. A continuable child whose exact parent is unavailable and which is not running elects a read-only composer explaining the recovery path; while such a child still runs, the selector yields to the ordinary composer with input and Send disabled but its independent Stop usable.

### The `@` reference source

The `@` source remains deliberately separate and inert: candidates are zero-RPC running children from `ctx.sessions.list`, picking one inserts literal `@label ` text, and the codec projects `@label`. It has no command-adjudication hooks and does not resolve labels into continuation addresses.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The catalog and composer behavior are specified by the [Web subagent conversations note](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.md) and the [current-turn interrupt note](../../../.agents/notes/implemented/feature/2026-08-06-continuable-subagent-interrupt.md).

### Catalog derivation

The header lineage renderer reads `subagentsByParent` and session summaries through the standard `useSessions` hook. The compact tree remains direct-catalog authoritative: each healthy row's `hasChildren` hint determines disclosure before interaction, a catalog level reserves the disclosure column only when at least one healthy row is a branch, and expanding a branch immediately reserves one disabled loading row per known direct descendant before lazily replacing them with that child's authoritative catalog. Membership updates refresh open branches, the selected session's children, and its direct-parent sibling catalog. Closing a menu preserves a pending refresh needed by the selected conversation. Catalog reads also update the running state of resident child conversations; selecting a catalog child initializes its existing conversation state before rendering.

### Duration and tokens

Token totals sum the four disjoint `tokenUsage` buckets. Duration sums completed `subagentTiming` turns, advances once per second only for an open turn on a running child, and freezes after the child becomes inactive; an interrupted open turn is bounded by its same-cut `active.through`, never by newer session metadata.

### Composer election

One-shot children always elect a read-only composer. A continuable child elects one only when its exact parent is unavailable and the child is not running; otherwise the ordinary composer's Session routes prompts through `subagents/prompt`. This package never receives host context or calls a model-facing tool.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the conversation surface, the host seam, and the design notes.

- [ui-conversation](../ui-conversation/README.md) — the chat surface hosting the header action and composer chain.
- [ui-input-trigger](../ui-input-trigger/README.md) — the suggestion machinery hosting the `@` source.
- [subagent](../../subagent/subagent/README.md) — the host-side capability seam behind continuable children.
- [Web subagent conversations](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.md) — the catalog and composer specification.
- [Current-turn interrupt](../../../.agents/notes/implemented/feature/2026-08-06-continuable-subagent-interrupt.md) — the independent Stop semantics.

-----

<a id="model-experience"></a>
## Model Experience

### Subagent label text in the user prompt

#### What the model sees

Only the `@` reference source affects model input: a picked candidate reaches the ordinary user message as literal `@label`, without a dedicated block or host-side resolution. Catalog browsing, child navigation, and persisted transcript viewing add no prompt section; accepted continuation content becomes a normal FIFO user message through the host subagent adapter.

#### Token effect

Conditional and append-only: the literal `@label` or a human follow-up adds tokens only to its new user message. Catalog and transcript operations add zero model tokens.

#### KV Cache effect

Append-only. This package never edits earlier request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the catalog can show and what `@` references mean; they are current package constraints.

- **The catalog has no durable outcome** — activity and timing do not distinguish completion, failure, or cancellation, and the UI exposes no Activation identity; stopping is limited to the composer's current-turn Stop for a running continuable child.
- **`@` references remain display-title text** — duplicate or renamed labels are ambiguous, so they intentionally do not acquire continuation semantics.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
