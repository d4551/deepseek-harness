# Agent Note: Agent Teams ship in every profile

Status: implemented

English | [中文](2026-09-07-agent-teams-in-every-profile.zh.md)

## Problem

The Team service, its scoped tools, the Agent Teams panel, and the Agent team settings card reached a user only through two profiles, `swarm` and `swarm-web`, because the [swarm reachability note](2026-09-03-swarm-reachability-and-child-roots.md) kept opt-ins out of shipped defaults. Every other execution type, `web`, `headless`, `hosted`, `sdk`, and `acp`, booted without them. A deployment composed from `dsh-base` and `dsh-web-app`, which is what the owner's DeepMeow install runs, showed no team card and no team panel, and its model could not spawn a teammate at all. The owner ruled that the capability belongs to every execution type, and that a deployment should not have to know a profile name to see plugins the repository ships.

The opt-in layer also cost two packages whose whole content was a copy of rows: `agent-team-profile` inserted the Team rows over `dsh-base` and disabled the global continuable-child controls whose names the Team tools reuse, and `agent-team-web-profile` inserted one browser row. The [drift note](../process/2026-09-03-swarm-layer-drift-and-atomicity-scope.md) had to add tests so `swarm-profile` and `agent-team-profile` could not diverge.

## Decision

`dsh-base` mounts `agent-team` and `tool-agent-team` for every profile, with the delegated policy, the eight-member roster, and the same mailbox and disposal limits the swarm layer restated. The policy tells the model to create teammates only when the user asks, so an ordinary session reads the Team tools without being steered into a swarm. `dsh-web-app` mounts `ui-agent-team` after `ui-subagent`, so every Web profile renders the roster, task board, and teammate navigation, and the Agent team card on the Plugins settings page renders wherever the `agent-team` namespace is served, which is now everywhere. One agent preset stays outside: `minimal` promises exactly persistent bash and the string editor, so `tool-agent-team` gained `excludePresets`, base sets it to `minimal`, and an Agent whose session header names that preset receives neither the Team tools nor the policy section. The Web bundle's other presets choose their delegation tools themselves and keep the Team.

Ordinary `subagent` and `subagent_fork` tools use one-shot execution in base and the `standard`, `ptc`, and `cordis` presets. Foreground calls return their result; background calls return jobs controlled by `job_output` and `job_kill`. `spawn_teammate` creates named, durable conversations with fresh or forked context. Team tools own `send_message`, `followup_task`, `list_agents`, `wait_agent`, and `interrupt_agent`. Base and the presets register no competing ordinary-child controls under those names. The host retains `tool-subagent-report` for continuable children; Team navigation and human follow-up use the addressed-child conversation path.

`swarm-profile` changes three base settings: concurrent one-shot runs become eight, retained teammate names become sixteen, and coordination becomes `swarm`. Its suite asserts that every row targets a base id, changes exactly its documented value, and restates every other key. Delegation-tool execution modes belong to base. The `swarm-web` template composes `dsh-base`, `dsh-web-app`, and `dsh-swarm-profile`; the panel and plugin-configuration browser scenarios boot the shipped bundles.

Every recorded session now carries the Team policy section and the eleven Team tool schemas, so the keyless goldens were refreshed. Two sdk scenarios were retired rather than refreshed: `subagent-continuable` had the model call the global `send_message` with a subagent id, and `subagent-list-agents` had it call the global `list_agents`; both tools are the Team's in every shipped profile now, and the package suites under `packages/subagent/subagent/tests/` and `packages/subagent/tool-subagent-control/tests/` keep the behavior those transcripts showed. The three notes that cited the scenarios say so. Two curated compositions keep the Team out on purpose, the way they keep most base tools out: the `persistent-tools` sdk scenario disables the two rows in its patch, and the Python runtime smoke's custom profile lists them among its disabled rows, so its committed expected outputs still describe the tool set they were recorded with.

## Alternatives considered

**Keep the Team an opt-in layer and compose it into the owner's deployment profile.** Rejected by the owner: the plugins should surface regardless of execution type, and a profile name should not be the gate to shipped capability.

**Keep `tool-subagent-control` and `tool-subagent-list-agents` in `dsh-base` beside the Team tools.** Rejected: the Team tools shadow them in every root scope, so they would be mounted and unreachable, and the two retired scenarios would still have broken.

**Restate one-shot delegation in the swarm layer.** Base already owns this setting. A repeated row would add a second configuration owner without changing swarm behavior.

**Make `coordination` a user setting on the Agent team card.** Deferred: the policy text is a composition decision today, and a setting that rewrites the system prompt mid-session needs its own logged event. The two shipped coordination modes remain profile layers.

## Consequences

Every profile except `sdk-minimal` answers with the Team tools available, and the Web app shows the panel and the card in every profile, including a deployment built from `dsh-base` and `dsh-web-app` alone. Every request in those profiles carries the delegated policy section and eleven more tool schemas, a fixed prefix-stable cost the opt-in design avoided. Every keyless recorded session changed in its system prompt and tool list and was refreshed; the swarm profile still has no recorded session, because recording needs a model key. A profile directory initialized from the old `swarm-web` template still lists `@deepseek-ai/dsh-agent-team-web-profile` in its `package.json` and must be re-initialized. The release-exclusion allowlist in `scripts/check-workspace-constraints.ts` is empty, because no preset layer stays private. The web goldens were refreshed against a production client build with `hmr-live.e2e.ts` excluded: that scenario starts the dev-web watcher, whose development-mode build rewrites `apps/web/dist` in place and crashes every later scenario's client with a Cordis inject error, so a local refresh runs it alone. Scenarios that already failed on this fork before the change keep their committed fixtures.
