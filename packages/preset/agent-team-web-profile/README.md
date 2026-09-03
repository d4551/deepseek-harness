---
description: "The browser layer of the swarm-web profile: one patch row that renders the Agent Teams roster, task board, and mailbox."
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-team-web-profile

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-agent-team-web-profile` is the browser layer of the shipped `swarm-web` profile. It carries one patch row, and that row is what makes [Agent Teams](../../subagent/agent-team/README.md) visible: the conversation header gains the Team roster, the shared task board, and teammate navigation. A Host Team layer supplies the domain; this bundle supplies the only surface a person can see it through, so a swarm without it runs entirely unobserved.

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

### Boot the shipped profile

```sh
dsh --profile swarm-web
```

`swarm-web` stacks `dsh-base`, `dsh-web-app`, [`dsh-swarm-profile`](../swarm-profile/README.md), and this package, in that order. The profile auto-initializes on first use like every other shipped template, and the browser opens on a session whose Agent is already a Team Lead.

### Add it to a profile of your own

```sh
bun run dsh plugin --profile web add ./packages/preset/agent-team-profile
bun run dsh plugin --profile web add ./packages/preset/agent-team-web-profile
```

The first command supplies the Team domain, generated Remote methods, and model tools over `dsh-base` alone; the second activates this package's declared patch and its browser presentation. `dsh plugin --profile web remove @deepseek-ai/dsh-agent-team-web-profile` removes the Web layer from the profile's ordered bundle list.

### What you get

The conversation header gains the Team roster, shared task board, and teammate navigation. [`@deepseek-ai/dsh-client-ui-agent-team`](../../client/ui-agent-team/README.md) owns those browser interactions and mounts the generated Client Remote namespace used to reach the Host Team service.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-web-app` and a Host Agent Teams layer, its single `insert` entry adds the `ui-agent-team` row for `@deepseek-ai/dsh-client-ui-agent-team`. The inserted Client plugin owns the generated Remote assembly and Team UI; this static bundle holds no mutable state and installs no runtime invariant.

Team tools register in each Agent's own scope. A nearer scope shadows a farther one in the tool registry, so the Web Agent presets' continuable-child controls (`list_agents`, `send_message`, `interrupt_agent`) are shadowed by the Team-scoped tools of the same names for every Team member, and no Team-aware preset is required to compose this layer.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered Web patch containing the `ui-agent-team` row |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |
| [`src/invariant.ts`](src/invariant.ts) | Empty invariant companion for the static bundle |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Swarm profile bundle](../swarm-profile/README.md) — the Host layer `swarm-web` stacks under this one.
- [Agent Teams Host profile](../agent-team-profile/README.md) — the same domain over `dsh-base` alone, for a profile of your own.
- [Agent Teams browser UI](../../client/ui-agent-team/README.md) — roster, task-board, and teammate-navigation behavior.
- [Web bundle](../../bundle/web-app/README.md) — the browser layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Host-side swarm layer selected under this Web layer.

#### KV Cache effect

This Web bundle adds no model request content; the Host-side Team tools own prompt, schema, and cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Ordered composition** — `dsh-base`, `dsh-web-app`, a Host Team layer, and this package must remain in that order. A patch inserting this row before the Host layer mounts a browser plugin whose Remote namespace has no Host owner.
- **Lead-only roster** — the panel reads the Team of the session's Lead. Opening a teammate conversation navigates to that child session; the panel there still shows the Lead's Team, because that is the Team the teammate belongs to.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
