# Agent Note: User-facing surfaces for swarm mode, multi-root sessions, workspace origin, and route hosting

Status: implemented

English | [中文](2026-09-03-user-facing-surfaces-for-shipped-capabilities.zh.md)

## Problem

Six capabilities shipped without a way for a person to see or use them.

**Agent Teams had a browser UI reachable from nothing.** `packages/client/ui-agent-team` was complete and tested, and the only patch that mounted it — `dsh-agent-team-web-profile` — was a private package no `dsh --profile` could name. The shipped `swarm` template stacks over `headless`, which serves no browser at all, so the roster, task board, and mailbox rendered for nobody.

**Multi-root sessions had no client surface.** The host recorded additional roots as `workspace/roots` events, and the sandbox write fence, search coverage, language-server routing, and per-root instruction loading all resolved them, but no client source read or wrote them. A person could not see which folders a session worked in, add one to a running session, or remove one; one Workspace meant one root, chosen at session start.

**A network-drive workspace was indistinguishable from local disk.** In the `hosted` profile the session workspace is a materialized mirror of a remote drive, and nothing said so.

**A LiteRT route was indistinguishable from a cloud API.** `dsh-llm-litert` serves models on the deployment's own hardware, or from a server the deployment named; the model picker showed a provider name and nothing else.

Two more surfaces stated nothing a reader needed. **A rendered fetch read as a plain one**: the shipped `fetchProvider: playwright` default executes the page's JavaScript, and the fetch card carried `url`, `statusCode`, and `truncated` only. **The shell card did not name its dialect**: `tool-bash` and `tool-pwsh` merged into one dialect-parameterized `dsh-tool-shell` whose dialect is chosen at boot by host platform, so a transcript reader could not tell which language a command was written in.

## Decision

### `swarm-web` is a shipped profile template

`PROFILE_TEMPLATES` gains `swarm-web`: `dsh-base`, `dsh-web-app`, `dsh-swarm-profile`, `dsh-agent-team-web-profile`, with live patch reload. The same host swarm layer the `swarm` template stacks over `headless` stacks over `web-app` instead, and the browser layer adds the one row that renders the Team.

`dsh-agent-team-web-profile` is no longer private: a shipped template's bundles must resolve from a packed `@deepseek-ai/dsh` install, so the package publishes and the CLI declares it in `dependencies`. Its `agent-team-profile` sibling stays private — that one layers Agent Teams over `dsh-base` alone, which no shipped profile stacks.

No Team-aware Agent preset is involved. Team tools register in each Agent's own scope, and the tool registry resolves a nearer scope over a farther one, so the Team-scoped `list_agents`, `send_message`, and `interrupt_agent` shadow the preset-scope continuable-child controls of the same names for every Team member. Every root Agent is implicitly a Team Lead, so every `swarm-web` session opens with the panel populated.

### The workspace-root seam gains its missing two roles

The read side is a **projection**: `workspaceRoots` folds the session's `workspace/roots` events and pairs them with the header `cwd`, registered by the Session Controller beside `modelSelection`. A client reads it through the standard-kit `useProjection`, so the rendered set is the folded log, live and after reconnect, with no client-side folding and no polling.

The write side is a **Remote command**: `session.setWorkspaceRoots` validates every path as absolute before resolving the Session — the same order `session.create` uses, so a root the enforcement layers cannot match never reaches the durable record — then calls `setAdditionalWorkspaceRoots`, whose single `workspace/roots` event is the change.

The Consumer is a new package, `packages/client/ui-workspace-roots`: a session-header action whose panel lists the primary root with its filesystem origin, every additional root, and the add/remove controls. A mutation is never optimistic; the rows move when the resulting event folds back through the projection.

### Filesystem origin is a capability fact on the seam

`FileSystem` gains an `origin` getter beside `sandboxMode`, the existing precedent for a capability fact a surface reads. The base class and every host-disk backend report `local`; `NetworkDriveFileSystem` overrides it with `network-drive`. `FsOriginKindMap` is merge-extensible, so a later backend declares its own member and a consumer's switch falls through a documented default.

`session.workspaceOrigin` is the wire face, read through `ctx.get('fs')` because the seam is optional to that package: a deployment that composes no filesystem provider gets `null`, which states nothing rather than claiming local disk. The origin is per deployment, not per root — the harness runs one filesystem provider — so the panel tags the primary root and that describes every path the session reaches.

### Route hosting is a capability fact on the LLM seam

`LlmProviderInfo` gains `hosting?: 'local' | 'self-hosted'`, read the way `LlmConfigurableProvider.declared` is read: absent means the adapter draws no such distinction, which is the only honest answer for a cloud API whose hardware the harness knows nothing about. `LitertAdapter` extends `PiAiAdapter` and attaches the posture its config resolution already selected. The registry carries it into `listProviders()`, `buildModelCatalog` carries it into the group, and the model picker renders it as part of the group heading, so it joins the group's accessible name.

There is no loaded-versus-importing state to show. `dsh-llm-litert` imports its models and health-waits its server before registering the adapter, so a route that is still importing is not in the catalog at all.

### Web fetch states how it retrieved the body

`WebFetchResult` gains `retrieval?: 'http' | 'rendered'`. The HTTP provider states `http`; the Playwright provider states `rendered`. It is optional on the seam because only a provider can answer and a backend outside this repository may not.

`presentationMeta` reads only the declared output value, so the fact rides through the tool's output schema as an optional field and into the persisted result meta, which is what the card derives from. `fetchMetaFromResult` drops a value outside the closed pair: an unrecognized word on a trust-bearing card is worse than no claim. The card shows "Rendered in a browser" or "Fetched directly" with a fuller sentence as its title.

### The shell card names its dialect

`dsh-tool-shell` registers under its dialect's name, so a call's tool name IS its dialect. `terminalCardModel` carries `bash` or `pwsh` onto the card, and `TerminalBlock` renders it as a badge beside the status. A `terminal_send` call states none: the harness never chose that session's shell.

## Alternatives considered

**Make `swarm` itself serve a browser.** Rejected: `swarm` is one headless task worked by a team, and its `startup` patch-reload lifecycle exists because replacing a one-shot application's dependencies mid-run invalidates it. A separate template keeps both postures.

**Put the `ui-agent-team` row in `dsh-swarm-profile`'s own patch.** Rejected: the `swarm` template would then insert a browser row into a tree with no browser, and every headless install would carry a client dependency it never serves.

**Write a Team-aware Agent preset for `swarm-web`.** Rejected as unnecessary once scope shadowing was confirmed: the Team-scoped tools already win over the preset-scope ones for Team members, so a preset fork would duplicate the standard preset to change nothing observable.

**Read the root set through a Remote call instead of a projection.** Rejected: a call is a point read that needs invalidation, and the browser already receives projection frames. The fold is pure and the whole-value rule makes each `workspace/roots` event self-describing, so the projection is both cheaper and reconnect-safe.

**Let the panel own the root list optimistically.** Rejected: the host decides what a session's roots are, and an optimistic row that a refused mutation left behind would disagree with the sandbox fence. The panel renders the projection and surfaces failures with a retry.

**Build an in-app directory tree in the root panel.** Rejected for now: `ctx.uiWorkspace` already owns the host chooser, and a typed absolute path works in every deployment including one whose composed picker serves only the browse capability. The panel's `Known Limitations` records the gap.

**Put the workspace origin in the `workspaceRoots` projection.** Rejected: a projection folds the session log, and the composed filesystem backend is not a session-log fact. It is a deployment probe, like `canOpenWorkspacePath`.

**Re-export `FsOrigin` from the Session Controller's browser vocabulary.** Rejected: that would put `dsh-fs` — and its cordis Context merge — into the client program's type graph for one string. The Remote declares its own `SessionWorkspaceOrigin` whose `kind` crosses the wire as a plain string, which is also what a merge-extensible vocabulary should look like on a wire.

**Special-case LiteRT by provider id in the model picker.** Rejected: the picker would then know one adapter's name, and a second on-device adapter would need another special case. The adapter states where its models run and the picker renders whatever any adapter states.

**Derive the fetch retrieval mode from the currently composed provider at render time.** Rejected: a card replays a call that already happened, and the composed provider can change between the call and the replay. The provider records it per result.

**Keep the retrieval mode out of the model's view.** Not available: `output.presentationMeta` receives only the declared output value, and the card must derive from persisted result metadata. Making it model-visible is defensible on its own terms — whether a page's scripts ran changes what the returned text can be expected to contain.

## Consequences

`dsh --profile swarm-web` renders the Team roster, task board, and mailbox; verified by booting it and fetching `/plugins/??@deepseek-ai/dsh-client-ui-agent-team/client.js` (HTTP 200, 208 kB) from the served browser roster.

A person can read and change a live session's folder set from the conversation header, and the change is durable: adding a folder appends `workspace/roots` to the session log, which is what every root consumer folds. `session.workspaceOrigin` answers `{"kind":"local"}` on a host-disk deployment and `network-drive` under `hosted`.

Every fetch card now states whether a browser engine ran the page, and every shell card names the language its command was written in. Both facts are recorded per call, so a replayed transcript states what actually happened rather than what the current composition would do.

Three seams grew one optional member each (`FileSystem.origin`, `LlmProviderInfo.hosting`, `WebFetchResult.retrieval`). Each is absent-means-unstated, so a provider outside this repository keeps working and its surface stays silent instead of guessing.

`dsh-agent-team-web-profile` is now a release payload member. Its published dependency `dsh-client-ui-agent-team` was already public.

## Testing

`packages/client/ui-workspace-roots/tests` covers the four states, both mutations, every failure path including the unmount races, and the axe floor for the trigger, panel, alert, and loading placeholder. `packages/api/session-controller/tests/session-workspace-roots.host.spec.ts` covers the projection fold, the replacement command, and the origin probe through the generated Remote face. Provider-level facts are asserted where they are produced: the HTTP and Playwright providers each pin their own `retrieval`, and the LiteRT plugin spec pins `hosting` for both postures.

## Deferred

The root panel has no in-app directory browser, so a deployment whose composed picker serves the browse capability rather than a native chooser answers Browse with a refusal and relies on the typed field.

The Team panel reads the Lead's Team; a teammate conversation shows the same Team, which is the Team that teammate belongs to.

## Related

[Swarm reachability and child roots](../architecture/2026-09-03-swarm-reachability-and-child-roots.md) owns the headless `swarm` template, the publication of `dsh-swarm-profile`, and the inheritance of additional roots across the delegation boundary. `swarm-web` stacks that same host layer over `web-app`, and the panel this note adds is what makes an inherited root set visible.
