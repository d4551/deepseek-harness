---
description: "Pure projections from durable Session data to Client view values, statically linked and seeded once for every Client row."
kind: "package-library"
---
# @deepseek-ai/dsh-client-ui-projection

English | [中文](README.zh.md)

## Summary

Durable-source to view-value folds every Client row reads the same way: context provenance and presentation form, Assistant block classification and stream accumulation, inbox splices and input-message records, Tool-call records and the subcall-graph bound, synthetic seq offsets, display-safe failure fields, the subagent descendant index, and the one-shot composer settlement adapter. A Conversation target decides what it renders from these values; how a logged source maps onto them has one owner here.

Membership rule: an export belongs in this package only when it is a stateless function or a frozen constant with no Cordis API, no module state, and no runtime identity a caller compares. That is what lets `apps/web` link one copy statically and the shell seed it into the frozen module table as a `PLATFORM_MODULES` word, so every dynamic Client bundle resolves the same instance instead of carrying its own. Anything with lifecycle, registration, or shared mutable state belongs on a Cordis service instead — `uiSession.registerPendingInteraction` owns the pending-interaction publication and settlement it used to share with this package.

The package takes no runtime dependency on any Client row. It reads the Conversation record and match types from `@deepseek-ai/dsh-client-ui-conversation/client` with `import type` only, so the edge is erased before emit and the browser module graph stays one-way.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

None, as this package projects already-logged Session data into browser view values and registers nothing model-facing.

#### KV Cache effect

None; the folds neither assemble nor send model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The Conversation record types stay in `ui-conversation`** — the folds here produce `AssistantBlock`, `RunningToolCall`, and their siblings, but those declarations remain with the merge-extensible `ConversationTurnDataMap` / `ConversationStepDataMap` maps that other rows augment. Moving them would relocate every `declare module` target, so this package type-imports them and the type graph points from the shared layer at the row rather than the other way round.
- **Adding an export is a shell change** — a new name here is only reachable once `PLATFORM_MODULES` and `packages/client/web/src/seed.ts` carry the package, so a consumer cannot pick it up from a package-local build alone.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`bun run verify-client-packages` enforces the two halves of the static channel: a `PLATFORM_MODULES` word whose owner is a workspace package must build through the `staticLinked` preset, and a dynamic consumer declares this package only in `devDependencies`. A consumer needs no `dsh.client.external` row — the gate rejects repeating a baseline module.

</details>
