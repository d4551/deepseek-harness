---
description: "Private swarm profile layer over dsh-base: many teammates work one request at once, pulling from the shared task board under a bounded one-shot run ceiling."
kind: "package-bundle"
---

# @deepseek-ai/dsh-swarm-profile

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-swarm-profile` is a private profile layer that turns [Agent Teams](../../subagent/agent-team/README.md) into swarm mode over `@deepseek-ai/dsh-base`. The Lead decomposes a request into shared tasks with write scopes and dependencies, spawns teammates, and every teammate pulls its own work with `team_task_claim_next` instead of waiting to be told. The patch also bounds the Subagent seam's concurrent one-shot runs, so a swarm that fans out foreground delegations queues instead of oversubscribing the host. Add it explicitly to an initialized source-checkout profile; official releases exclude this package.

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

### Install into a profile

From this repository checkout, add the package to an initialized profile, then run a task large enough to split:

```sh
bun run dsh plugin --profile headless add ./packages/preset/swarm-profile
bun run dsh --profile headless "Split this refactor across a swarm and report when the board is empty."
```

The profile must already contain `@deepseek-ai/dsh-base`, whose Subagent services and provider rows this layer consumes. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-swarm-profile` removes the bundle from the profile's ordered layer list.

### What you get

The layer adds the Agent Teams domain and its scoped tools with `coordination: swarm`, which selects pull-based guidance in place of the delegated policy. It disables the global continuable-child control rows whose tool names overlap with Team controls, leaves `subagent` and `subagent_fork` available as one-shot delegation tools, and gives `ctx.subagents` a `maxConcurrentRuns` ceiling.

### Tuning the run ceiling

`maxConcurrentRuns` on the `subagent` row is how many one-shot child runs the deployment may have published at once; a start beyond it queues in arrival order and dispatches as soon as an earlier run settles or is disposed. Teammates are continuable children and are not counted: an Activation is resident for as long as its conversation lasts, so counting one would park foreground delegations behind long-lived members. Raise the value for a host with more capacity, and lower it when several swarms share one machine.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-base`, the patch bounds the `subagent` row, disables `tool-subagent-control`, `tool-subagent-list-agents`, and `tool-subagent-report`, sets the fresh and fork Subagent rows to `one-shot`, and inserts the Team service and tool rows with explicit providers, limits, and the swarm coordination mode.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`src/invariant.ts`](src/invariant.ts) | Empty invariant companion for the static bundle |

The package's own suite boots the rows this patch inserts through the real Loader and asserts the resulting composition: the configured run ceiling on `ctx.subagents`, `team_task_claim_next` in the assembled tool schemas, and the swarm guidance in the rendered prompt.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams service](../../subagent/agent-team/README.md) — durable roster, messaging, and task-board behavior, including the atomic claim.
- [Agent Teams tools](../../subagent/tool-agent-team/README.md) — the Team-scoped model tool surface and its coordination modes.
- [Subagent seam](../../subagent/subagent/README.md) — the run ceiling this patch configures.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

### Swarm policy and tools

#### What the model sees

The policy text and tool schemas belong to [`@deepseek-ai/dsh-tool-agent-team`](../../subagent/tool-agent-team/README.md). This bundle selects the swarm policy: the Lead is told to decompose into tasks with write scopes before spawning anyone, and every member is told to take work with `team_task_claim_next` and to read a `none` outcome as an ordinary board state rather than a failure. Team-scoped `list_agents`, `send_message`, and `interrupt_agent` replace the disabled global continuable-child controls.

#### Token effect

The bundle adds the swarm policy section and the Team tool schemas described by `dsh-tool-agent-team`; it adds no prompt text of its own.

#### KV Cache effect

The bundle's composition is prefix-stable while its patch, Team identity, and configured tool schemas remain unchanged. A queued one-shot start changes latency only and rewrites no prompt prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Source-checkout only** — this private package is not present in official npm, CLI, Web, or Python release payloads.
- **Shared checkout** — every teammate observes the same working directory; write scopes are advisory task metadata, not filesystem locks, and this bundle adds no worktree isolation.
- **Base profile required** — the patch depends on row ids and Subagent providers supplied by `dsh-base`; it is not a standalone profile.
- **One ceiling per deployment** — `maxConcurrentRuns` bounds the whole process, with no per-Team or per-member sub-quota.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
