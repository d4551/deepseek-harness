# Agent Note: Make swarm mode reachable, enforce the write-scope exclusion, and give children every root

Status: implemented

English | [中文](2026-09-03-swarm-reachability-and-child-roots.zh.md)

## Problem

Three defects, each a claim the code did not keep.

**Swarm mode shipped nowhere.** `packages/preset/swarm-profile` set `private: true`, sat in the release-exclusion allowlist in `scripts/check-workspace-constraints.ts`, was named by no `PROFILE_TEMPLATES` row, and was declared by no `apps/cli` dependency. `packages/bundle/base/cordis.patch.yml` carries the `subagent` seam and its two in-process providers but no `agent-team` or `tool-agent-team` row, so the coordination substrate was absent from every shipped composition. The `maxConcurrentRuns: 8` in the swarm layer bounded nothing a user could run; the shipped ceiling stayed the seam's own default. The deliverable was a working feature and its only entry point was a source checkout.

**The write-scope exclusion was enforced on one path and open on its sibling.** `TeamTaskBoard.claimNextReady` skipped a candidate whose write scopes overlapped an in-progress task, and `team_task_claim_next`'s description told the model that no two members write the same paths. `TeamTaskBoard.update` performed no scope check, and `team_task_update` exposes `claim` in both coordination modes, so the same model could take the same task through the named route. `reassign` and a scope-widening `edit` reached the same transition. The overlap surfaced only as the advisory `writeScopeWarnings` string a test asserted while claiming `src` and `src/nested` at once. Schema omission was not available as a fix and would not have been enforcement anyway: the service method is the operation that makes the decision.

**Additional workspace roots stopped at the delegation boundary.** `childSessionMeta` copied `cwd` from the parent header and nothing else about the workspace. `setAdditionalWorkspaceRoots`, `workspace/roots`, and `sessionWorkspaceRoots` appeared nowhere under `packages/subagent/`, `packages/core/agent/`, or `packages/core/agent-loop/`. Every `subagent`, `subagent_fork`, and Team teammate therefore ran in the primary root alone: its sandbox write fence, search coverage, language-server routing, and per-root instruction loading all collapsed, silently, in the middle of a task the parent had scoped across several folders.

## Decision

**The swarm layer publishes in place and a shipped `swarm` profile stacks it.** `@deepseek-ai/dsh-swarm-profile` drops `private` and declares `publishConfig.access: public`; its allowlist entry is removed, because a publishable package cannot stay in the release-exclusion map. `PROFILE_TEMPLATES.swarm` is `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-swarm-profile']` with `patchReload: 'startup'`, and `apps/cli` declares the bundle as a dependency so `resolveBundleDir` can find it from the installation anchor. `dsh --profile swarm "<task>"` is the entry point: one headless task, many teammates, one shared board, the configured run ceiling.

The layer stays a self-contained patch document rather than a delta over `agent-team-profile`, which is the [existing decision](../process/2026-09-03-swarm-layer-drift-and-atomicity-scope.md) — a bundle cannot require a predecessor, so a user who applies only the delta would get a Loader warning instead of a refusal. The two documents remain a checked copy, and the equivalence and base-row-id tests that keep them from drifting are unchanged.

The layer stays under `packages/preset/`. Moving it to `packages/bundle/` would match the group definitions more exactly, but the move rewrites generated tsconfig path aliases, the module graph, and the config catalog while other work is in flight in those files, and it buys nothing the template row does not already deliver.

**The write-scope exclusion is enforced at the commit that leaves a task in progress.** `TeamTaskBoard.update` asserts, after the task-graph check and before the journal append, that no other in-progress task holds an overlapping prefix, and refuses with `TEAM_TASK_WRITE_SCOPE_CONFLICT`. The condition is the committed snapshot's status, not the action name, so `claim`, `reassign`, and a scope-widening `edit` are all bound and no future action can be added outside it. `release`, `complete`, `reopen`, and `delete` never leave a task in progress and are unaffected.

`claimNextReady` keeps deferring rather than refusing, and that asymmetry is the point: its caller asked for whatever work is free, so a collision is an ordinary board state it reports as `write-scope-conflict` with the deferred ids. `update` names one task, so a collision is a refusal of the thing that was asked for. One private `busyOverlaps` helper backs the deferral, the refusal, and the `writeScopeWarnings` a pending task's view carries, so the three cannot disagree about what overlaps.

`writeScopeWarnings` stays. Under the exclusion an in-progress task can no longer carry one, but a pending task's view still names the in-progress work blocking it, which is what a member reads before deciding to wait. The prefixes remain the board's exclusion key and not a filesystem lock: nothing stops a member from writing outside its claimed scope, and the READMEs, the subsystem page, and both coordination policies now say that instead of calling the scopes advisory.

**A child inherits its parent's workspace the same way it inherits its policy.** `DelegatedPolicyOverrides` becomes `DelegatedSessionState` and gains `workspaceRoots`; `captureDelegatedPolicyOverrides` and `appendDelegatedPolicyOverrides` become `captureDelegatedSessionState` and `appendDelegatedSessionState`. The capture reads `effectiveWorkspaceRoots(parent.session.events)` synchronously before the child start's first await, beside the sandbox override and the approval pin, so a parent that changes its roots afterwards changes only its own future. The append writes them through `setAdditionalWorkspaceRoots` inside the unpublished creation window, which drops a root equal to the child's primary root and appends nothing when a fork seed already carried the same set.

Model-visible is therefore logged: the child's roots live on the child's own log as one `workspace/roots` event, `sessionWorkspaceRoots` folds them, and a cold resume replays them instead of re-deriving them from a parent that may be gone. Renaming the pair rather than adding a second one keeps the one capture point the [continuable-policy note](../feature/2026-08-10-continuable-subagent-policy-inheritance.md) established: the one-shot driver and the continuation manager both call it, so the two delegation paths cannot drift, and a Team teammate — a continuable child — is covered by construction.

The four out-of-process providers (`subagent-codex`, `subagent-claude-code`, `subagent-acp`, `subagent-dsh-sdk`) still hand on the primary root alone. They start a foreign agent that owns its own session and takes its workspace from its own configuration or, for ACP, from a `session/new` that carries a single `cwd`; carrying a root set across those interfaces is a per-product change with its own protocol evidence. No shipped bundle mounts any of them. Each README now states the limit under Known Limitations rather than leaving the narrowing silent.

## Verification

`bun x vitest run packages/subagent packages/preset packages/bundle apps/cli` — 1187 passed, 3 failed, all three in `packages/subagent/subagent-codex/tests/real-product.spec.ts` and environmental: this host carries a managed Codex policy at `/etc/codex/requirements.toml` with `allow_managed_hooks_only = true`, and its `PreToolUse` hook denies the fixture's writes — `[MAS hardban-edit-guard] DENIED write ... Command: touch approval-side-effect` is the only hook line the run emits. Each denial costs the child a turn, so the scripted fixture runs out of responses before the case completes. Run alone the file fails exactly those three.

`apps/cli/tests/profile-bundles.spec.ts` passes: every bundle every template names is a declared `apps/cli` dependency. `packages/boot/app-boot/tests/profile.spec.ts` pins the new template tuple and the shipped-profile list the missing-profile diagnostic prints. `packages/preset/swarm-profile/tests/profile.spec.ts` now asserts the manifest is publishable, and its Loader boot of the shipped rows is unchanged.

The write-scope work is proved through the executor, not the tool schema. `refuses every named route that would start work on paths already being written` claims `src`, then refuses a `reassign` to a teammate, a teammate's own `claim`, and an `edit` widening an admitted `docs` task onto `src/deep`, and finally shows every route opening once the held task is released. The obsolete case that demonstrated the bypass now asserts the refusal, that nothing was committed, and that the refused task's view names the task blocking it.

The root work is proved by consequence. `gives a spawn child every workspace root its parent works in` has the child `write` into a second root under a `workspace-write` sandbox and reads the file back; reverting the append line fails it with the sandbox denial. `records no roots for a single-root parent` holds the empty case. `seeds the parent workspace roots and reconstructs them on cold resume` checks the live child, drops the root from the parent, follows up, and asserts the persisted child log still folds to the delegation-time set with exactly one `workspace/roots` event. `gives a teammate every workspace root its Lead works in` covers the Team path.

Per-file coverage is 100% on statements, branches, functions, and lines for every source file changed: `agent-team/src/{task-board,index,validation}.ts`, `tool-agent-team/src/index.ts`, `subagent/src/{child-agent,continuation,index}.ts`, `subagent-in-process-driver/src/index.ts`, and `app-boot/src/profile.ts`. `bun run constraints`, `bun run verify-package-invariants`, `scripts/no-barrels.ts`, `scripts/verify-export-jsdoc.ts`, `scripts/run-oxlint.ts`, and scoped `tsc -b` all pass. `bun run test:snapshot` replays unchanged: no shipped default composition mounts the Team tools, and no recorded session declares additional workspace roots. `bun run gen-cordis-catalog` regenerated the two Team service contracts in `docs/subsystems/agent-team.md` and its Chinese pair.

## Alternatives considered

**Put the Team substrate into `packages/bundle/base`.** Rejected: it would give every profile the Team tool surface and its prompt policy, and opt-ins stay out of shipped defaults.

**Split swarm into deltas over a published `agent-team` bundle.** Rejected for the reason the drift note already recorded — nothing enforces that a user stacks both, and applying only the delta warns instead of refusing.

**Leave `claim` advisory and document the difference from `claim_next`.** Rejected: the claim-next tool description promises the model that two members never write the same paths, and a documented hole in that promise is the hole.

**Refuse only `claim`.** Rejected: `reassign` performs the same transition under Lead authority, so the exclusion would have moved one action over rather than closing.

**Carry the roots in `childSessionMeta` beside `cwd`.** Rejected: additional roots are a log fact by design, with the fold as the only reader, and a second home in the header would need its own resume and replay story.

**Refuse a delegation to an out-of-process provider when the parent has extra roots.** Rejected: a capability gap is not misconfiguration, and refusing would break working single-root-relevant delegations for a narrowing that a README bullet states accurately.

## Consequences

`dsh --profile swarm` is a shipped entry point and its bundle travels in the release payload; the missing-profile diagnostic lists it. A patch row that renames a `dsh-base` subagent id now breaks a shipped profile rather than an opt-in layer, which the layer's existing base-row-id test catches.

No route on the Team board can start two owners on overlapping write scopes, and `TEAM_TASK_WRITE_SCOPE_CONFLICT` is a new stable code the model sees. Both coordination policies gained one sentence each; a swarm Lead that decomposed into overlapping scopes now gets a refusal it must resolve rather than a warning it can ignore.

Every in-process child session carries its parent's complete workspace, and its log says so. A recorded swarm session and a keyless snapshot for `--profile swarm` remain to be added; recording needs an API key, so the layer's coverage is currently the Loader-real composition test plus the headless Team end-to-end run.

`swarm` and `hosted` are now named in `apps/cli/README.md` and `docs/architecture.md`, and a fifth case in `apps/cli/tests/profile-bundles.spec.ts` fails when a shipped template is missing from either page or its Chinese pair. Reachability had been read as a resolution property, so both profiles booted while no page a user reads mentioned `swarm` at all: `architecture.md` listed six of seven templates, and the CLI README named five as auto-initializing when all seven are. Three further sentences were wrong in the same way rather than merely incomplete — `dsh-base` described as the first layer of four named profiles when it underlies every shipped profile but `sdk-minimal`, the patch-reload split omitting both new profiles, and Agent Teams described as disabled "until a profile patch enables it" when the shipped `swarm` profile is that patch. Stripping the backticked `swarm` from `architecture.md` fails the new case with `docs/architecture.md -> swarm`.
