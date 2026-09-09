# Agent Note: Agent Teams Web controls

Status: implemented

English | [中文](2026-08-06-agent-teams-web.zh.md)

## Problem

The durable Agent Teams runtime owns roster, mailbox, and task state. Web users need to inspect teammate activity, manage shared tasks with the same compare-and-set rules, and open a teammate conversation. The Team service must own these operations without duplicating its contracts in the API Proxy or Session Controller.

## Decision

The private `ctx.agentTeams` service owns generated `agentTeams/view`, `agentTeams/createTask`, and `agentTeams/updateTask` Remote methods beside its domain operations. The Team package owns the browser-safe view and mutation-result types. Views contain roster, current tasks, descendant conversations, and peer messages with delivery state; deleted task tombstones remain omitted. Descendant activity comes from the live Agent driver, while parent relationships and messages come from durable state. Create and update rejections cross Remote as closed business results; stale update revisions preserve `team-task-conflict`, while other Team rejections preserve `team-rejected`. Unexpected failures remain ordinary `RemoteResult` failures.

`@deepseek-ai/dsh-client-ui-agent-team` mounts the `@deepseek-ai/dsh-agent-team/remote` contribution through `ctx.remote`, then consumes the generated `ctx.remote.agentTeams` methods directly. It displays roster status, model and diagnostics and supports task create, edit, dependency update, assignment, completion, reopen, and deletion. Every update sends the displayed revision. Each create or update owns an independent pending token, invalidates older refreshes before starting, and reloads the complete Team view after success. A conflict asks the user to review only after its reload succeeds; a reload failure remains visible. Overlapping refreshes publish only the latest request for the selected Session.

While open, the panel subscribes to `agentTeams/changes` and coalesces activity during view reads. Closing, switching conversations, or unmounting cancels the subscription and invalidates outstanding reads. Task forms use shared inputs and buttons with persistent labels, native Enter submission, and disabled fields during saves. Escape and Close restore trigger focus; outside pointer dismissal preserves the clicked target's focus.

Teammate navigation uses the existing `{ parentSessionId, childSessionId, mode: 'continuable' }` Subagent address without a Team tag. The UI refreshes the direct-child catalog, rechecks the selected Session, and opens the addressed conversation. History and later human prompts follow the stable Subagent path; the Team mailbox remains reserved for Team peer delivery from Team tools.

`dsh-web-app` mounts the UI as its `ui-agent-team` row after `ui-subagent`, over the `ctx.agentTeams` service and model tools that `dsh-base` mounts ([Agent Teams ship in every profile](../architecture/2026-09-07-agent-teams-in-every-profile.md)).

The `standard`, `ptc`, and `cordis` presets expose one-shot `subagent` and `subagent_fork` delegation. Named Team members own durable follow-up work through `spawn_teammate` and Team controls; the presets register no competing Subagent control or roster tools.

## Boundaries

The Web UI has no worktree or Git controls, teammate creation, rename, deletion, interruption, or automatic merge behavior. It does not infer filesystem authority from task ownership or write scopes. A human continuation after teammate navigation is an ordinary addressed-child prompt, not a Team mailbox message.

## Alternatives considered

**Extend the API Proxy Team RPC map.** Rejected because it would duplicate the generated Remote vocabulary and validation in a second wire package.

**Introduce a separate browser Remote service.** Rejected because the methods have no state, lifecycle, or policy owner distinct from `ctx.agentTeams`; a second Cordis service would duplicate Team injection and require another package for the same Typert namespace.

**Add Team metadata to the Subagent address and prompt routing.** Rejected because ordinary child navigation already identifies the conversation. A Team tag would couple Client and Subagent contracts to mailbox policy.

**Put disabled Team rows in the Web bundle.** Disabled rows would leave users without the controls despite including their dependencies. The [profile composition decision](../architecture/2026-09-07-agent-teams-in-every-profile.md) mounts active Team controls and their service together.

## Testing

Team-service tests and built-artifact checks verify the Remote methods, error mapping, and exported descriptors. Client tests cover namespace mounting, Lead routing, task actions, pending operations, conflict reloads, stale replies, navigation, disposal, status presentation, persistent labels and keyboard submission. Assembled browser tests exercise the real Host Remote flow, live updates and child conversations, and run full-page axe checks in light and dark themes. These keyless tests do not establish real-model behavior.

## Consequences

The Team service owns domain state and the Remote operations that expose selected Team values. API Proxy and Session Controller retain ordinary conversation contracts. Every Web profile mounts the Team controls through the Web bundle; users do not need additional profile layers.
