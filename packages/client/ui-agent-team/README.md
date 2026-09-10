---
description: "Use and debug the Web Agent Teams roster, shared task board, and teammate navigation panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds an Agent Teams action to the Web conversation header for following agent-owned tasks, messages, and activity and opening member conversations. It reads authoritative Team state through the generated `ctx.remote.agentTeams` contribution and keeps child-history navigation on the addressed-subagent path. The Web bundle mounts it in every Web profile. The browser projection does not store Team state or register model-facing input.

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

[`@deepseek-ai/dsh-web-app`](../../bundle/web-app/README.md) mounts this package as its `ui-agent-team` row in every Web profile, over the Team service and tools that [`@deepseek-ai/dsh-base`](../../bundle/base/README.md) mounts. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

Opening the panel subscribes to `agentTeams/changes` and reads `agentTeams/overview` for its initial state and subsequent updates. Roster rows show durable names, descriptions, runtime status, model, and diagnostics. Selecting a healthy teammate refreshes the existing direct-child catalog and opens the ordinary `{ parentSessionId, childSessionId, mode: 'continuable' }` address. History and later human prompts continue through the stable addressed-subagent conversation path; this package adds no Team-specific address field.

Messages occupy the primary panel, showing sender, recipient, preserved paragraphs, and queued or delivered state. Registered workspace peers' incoming replies appear with outgoing messages, ordered by journal event time. The independent `agentTeams/conversations` read lists nested subagents with their direct parents and activity. History loading or failure leaves messages and tasks available; Refresh conversations retries the directory. Selecting a descendant opens its exact parent-child address; the Lead row returns to the root conversation.

### Follow agent-owned work

The task board displays agent-managed work, ownership, dependencies, readiness, write scopes, and overlap warnings. Other live conversations' task boards come from registered workspace membership and update with Team activity. Agents receive these boards in their coordination guidance and maintain tasks and handoffs through Team tools. The panel has no task-entry, assignment, or editing controls. It displays committed task state; an idle member is not evidence that its task is completed.

Escape, Close, or clicking outside dismisses the panel; Escape and Close return focus to its trigger.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export mounts the generated `ctx.remote.agentTeams` contribution from [`@deepseek-ai/dsh-agent-team/remote`](../../subagent/agent-team/README.md), then registers its locale dictionaries and one conversation-header slot through Cordis effects. Disposing the plugin fiber removes both registrations.

Each published overview also refreshes the descendant directory. Directory failures have an independent retry action and leave task and message observations available.

The live subscription coalesces activity while a view read is pending. Closing the panel, changing conversations, or unmounting cancels it and invalidates outstanding reads. An interrupted stream displays an error; reopening the panel establishes a new subscription and reads current state.

The shared workspace-sized Modal and PanelLayout primitives provide aligned responsive rows and viewport-constrained scrolling. Shared buttons, pills, message bodies, and activity dots provide its controls without a panel stylesheet or inline styling.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Generated Remote, locale, navigation, and slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Roster and task-board interaction state |
| [`src/client/TaskCard.tsx`](src/client/TaskCard.tsx) | Agent-owned task progress, ownership, and dependencies |
| [`src/client/TeamMessages.tsx`](src/client/TeamMessages.tsx) | Durable interagent messages and delivery state |
| [`src/client/TeamConversations.tsx`](src/client/TeamConversations.tsx) | Live descendant directory and navigation |
| [`src/client/observe-team.ts`](src/client/observe-team.ts) | Bounded activity consumption and subscription cancellation |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web bundle](../../bundle/web-app/README.md) — the shipped bundle that mounts this Client plugin.
- [Agent Teams service](../../subagent/agent-team/README.md) — authoritative roster, task, and Remote behavior.
- [Conversation UI](../ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path, not the Team peer mailbox.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, and write scopes remain advisory metadata.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
