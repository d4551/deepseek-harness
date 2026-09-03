# Agent Note: Two swarm claims wider than the code, and a fork no gate could see

Status: implemented

English | [中文](2026-09-03-swarm-layer-drift-and-atomicity-scope.zh.md)

## Problem

An audit of swarm mode returned DONE and then named two things the deliverable had not settled.

`docs/subsystems/agent-team.md` said `claimNextReadyTask()` runs "under the same per-Lead transaction every board mutation uses, so two members can never claim one task." The transaction is a promise chain held in one process, and `roster.tryMembership` admits a member only when `ctx.agents` still holds that exact live `Agent`, so the exclusion covers one host process. Neither the page nor the two JSDoc contracts on `claimNextReadyTask` and `claimNextReady` said so, while `freshProvider` and `forkProvider` are free-form strings that invite the wider reading.

`packages/preset/swarm-profile/cordis.patch.yml` is a 49-line near-copy of `agent-team-profile`'s 40-line patch. The whole difference is a header comment, one `subagent` row setting `maxConcurrentRuns: 8`, `maxMembers` 8 to 16, and `coordination: swarm`; the disable rows for the global continuable-child tools and the `agent-team` insert are identical. `bun run duplication` reads TypeScript, so nothing in the repository could see it. A rename in base's subagent rows needs both files edited, and a patch whose target row is absent stays a Loader warning by design — so the miss would surface as swarm mode booting with both `list_agents` registered and a line on stderr.

## Decision

The three prose sites now say the exclusion is process-scoped and name the mechanism that scopes it: a promise chain in this process, and membership requiring the exact live `Agent` this process holds.

The fork stays a fork, and two tests make it a checked one. A standalone profile layer has to be self-contained — bundles declare only `dsh.bundle.patch`, with no way to require a predecessor, so splitting swarm into deltas would leave a user who applies it alone with a warning instead of a working composition. What the duplication needed was not removal but a reader.

`is the Agent Teams layer plus exactly its documented swarm deltas` parses both patches through the Loader's own entry schema and asserts swarm equals the team layer with exactly the three documented changes applied. `targets only row ids the base bundle actually declares` reads `dsh-base`'s patch and asserts every id this layer targets exists there, which turns the by-design warning into a failure for this layer.

Both were proved by mutation: renaming one shared disable target fails three of the four cases, and changing `maxConcurrentRuns` from 8 to 9 fails the equivalence case alone.

## Alternatives considered

**Split swarm-profile into deltas applied over agent-team-profile.** It is the honest shape of the relationship and the composition order supports it, but nothing enforces that a user adds both, and the failure mode of adding only swarm is a warning, not a refusal. A checked copy is safer than an unenforced dependency.

**Teach the duplication gate to read YAML.** jscpd supports more formats, but the marked regions across this repository are TypeScript, and turning on a format whose corpus has never been measured would land an unknown number of findings in one step. The two tests answer this pair now; widening the gate is its own change.

**Make a missing patch target fail the load.** The warning exists so one overlay can be shared across surfaces that do not all carry the same rows — a real requirement with its own note. Changing it repo-wide to fix one layer would trade a documented tradeoff for an undocumented one.

## Consequences

The atomicity claim states its scope in the subsystem page and at both call sites. The two preset layers cannot drift apart, and swarm-profile cannot target a base row that no longer exists, without a test failing. The duplication between them remains, and remains deliberate.
