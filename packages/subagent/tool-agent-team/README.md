---
description: "Eleven tools that let the model create, message, and coordinate teammates, for compositions mounting the Team plugins."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-team

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-agent-team` provides eleven scoped tools for creating teammates, exchanging messages, checking progress, and managing a shared task board. The default `delegated` policy requires an explicit team request. The `swarm` policy has the Lead create tasks and teammates that claim ready work. Both policies coordinate edits in a shared workspace. The package publishes as a prerelease without a stability promise.

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

Add this package on top of `@deepseek-ai/dsh-agent-team` when the model should run a team through tools. Once mounted, every team member — the Lead and each teammate — gets the same eleven tools plus a policy paragraph that states its own role and name.

### When to choose it

Choose it when the model should create and coordinate teammates. Team-scoped tools take precedence over global tools with the same names. Choose `delegated` for explicit delegation requests or `swarm` for work distributed through the task board.

### Smallest working example

The smallest addition to an existing composition is the two-package fragment from the [agent-team README](../agent-team/README.md#smallest-working-setup): durable session storage, the team domain package, and this package. The plugin itself takes four optional settings:

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

| Field | Default | Meaning |
|---|---|---|
| `freshProvider` | `spawn` | Provider that starts fresh teammates |
| `forkProvider` | `fork` | Provider that starts fork teammates |
| `coordination` | `delegated` | Guidance the members receive: `delegated` or `swarm` |
| `excludePresets` | `[]` | Agent preset ids whose Agents keep their preset's exact tool set and receive no Team tools |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-agent-team) is the exhaustive source for every accepted field and its JSDoc.

With `coordination: swarm`, the Lead decomposes work into shared tasks and teammates claim ready tasks with `team_task_claim_next`. When the command registry is mounted, `/swarm <request>` submits a new request to the Lead's normal turn queue. The request must contain text and may include images. The command is absent from delegated compositions, excluded presets, and teammate scopes.

Try it by asking the Lead model: "create a teammate named reviewer to check the diff, then send reviewer the change summary". The model calls the creation tool and then the messaging tool.

### What the model can do

The eleven tools group into four capabilities:

- **Create a teammate** — `spawn_teammate` takes a name, a description, and the initial task; only the Lead can call it.
- **Send messages** — `send_message` delivers information without waking an idle teammate; `followup_task` makes the message the recipient's next turn and wakes it when needed.
- **See and wait** — `list_agents` shows the roster with live status; `wait_agent` waits for the next team change; `interrupt_agent` stops a teammate's current turn (Lead only).
- **Manage the task board** — `team_task_create`, `team_task_list`, `team_task_get`, and `team_task_update` add, browse, read, and update shared tasks. `team_task_claim_next` claims the next ready task without overlapping an active task's write scopes.

Any member can message any other member and use the task board; only the Lead creates and interrupts teammates. Task updates keep the domain's owner and revision checks, so an outdated edit is rejected instead of overwriting newer work.

### What success and failure look like

Sending a message succeeds as soon as it is safely stored: the result is `accepted` (delivered now) or `queued` (waiting), and a queued message must not be resent. `wait_agent` returns `noProgress` right away when no other member is running or provisioning, telling the caller to wake a teammate first; otherwise it waits for the next change and the caller re-reads state afterward. Task edits based on an outdated revision are rejected rather than overwriting newer work.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool plugin and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The tool plugin is built on three commitments:

- **Scoped, not global.** Every registration lives on the member Agent's own `ctx`; nothing is installed for non-Team subagents or the host.
- **Declared results, compact JSON.** Every tool declares its complete result schema and renders that value as compact JSON, so the compiler checks `execute` against what the model is promised and no result spends tokens on indentation.
- **The domain owns authority.** Every tool calls `ctx.agentTeams` directly, which enforces Lead authority and revision checks; this package adds no weaker path.

The [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) owns the model-facing and scoping decisions.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, coordination policies, and eleven scoped tool registrations |
| [`src/swarm-command.ts`](src/swarm-command.ts) | Lead-scoped request submission through the command registry |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; delegation is observable only through `ctx.agentTeams`) |

### Policy and tools

One `team:policy` section teaches each member its role and configured coordination rules. The policy text and eleven tool registrations are declared in [`src/index.ts`](src/index.ts). Tool schemas appear only in Team member scopes and take precedence over global tools with matching names.

### Scoped registration and teardown

`maybeInstall` runs for every live Agent and subscribes to `agent/created`; it skips Agents without Team membership. Disposal of an Agent runs the installed disposer, and plugin HMR disposes every installed scope before reinstall. Each disposer unwinds registrations in reverse order, so a failed install cannot leave a partial scope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the domain service to the exact schemas and the decisions behind the design.

- [agent-team package](../agent-team/README.md) — the `ctx.agentTeams` domain service behind these tools.
- [Agent Teams subsystem](../../../docs/subsystems/agent-team.md) — durable Team types and service API.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agent-team) — every tool schema the model receives.
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.md) — model-facing, scoping, and isolation decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

One policy section states the Team role/name/id, configured coordination policy, shared-cwd behavior, filesystem stale-version recovery, Bash/formatter/codegen risk, task and write-scope coordination, quiet versus waking delivery, the no-retry mailbox rule, and the Lead's duty to wait before answering. The eleven Team schemas from `spawn_teammate` through `team_task_update` appear only in Team member scopes.

#### Token effect

Fixed policy and schema cost on every Team member request. Tool calls add compact JSON roster, task, wait, or receipt results. Peer content is retained by the Team domain in the target's history.

#### KV Cache effect

Prefix-stable while the Team plugin generation, configuration, member role/name, and schemas remain unchanged. The per-member identity line differs across Agents. Tool results and peer messages append after the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe what the policy and tools cannot guarantee for a team. They are current package constraints, not a comparison with other collaboration surfaces.

- **Prompt policy is coordination, not confinement** — it cannot stop Bash or external processes from writing overlapping files.
- **Delegation follows the configured policy** — `delegated` requires an explicit team request; `swarm` instructs the Lead to create tasks and teammates for parallel work.
- **No Web controls** — browser roster and task-board presentation is outside this runtime package.
- **Prerelease with no stability promise** — the package publishes at `0.x` alpha and its schemas still change freely.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
