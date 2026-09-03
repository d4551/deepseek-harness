# Agent Note: Session pre-commit staging has one owner

Status: implemented

English | [中文](2026-09-03-session-staging-plumbing-owner.zh.md)

## Problem

Seven packages fold a package-owned relation over the session event log: `dsh-session`, `dsh-compaction`, `dsh-goal`, `dsh-hook-protocol`, `dsh-user-approval`, `dsh-tool-workflow`, and `dsh-tool-todo`. Each one validates a candidate during `internal/dispatch`, where a thrown failure rejects the append, and commits the accepted result during `session/event`, where the event is already in the log. Every one of them hand-wrote the same plumbing for that split: a `WeakMap` of per-session committed state, a second `WeakMap` of results staged by event object, a seed loop over `session.events`, adoption of a session first seen at dispatch, and the `session/created` + `internal/dispatch` + `session/event` listener trio.

`bun run duplication` reported three clones inside that plumbing — `dsh-compaction` against `dsh-user-approval` (12 lines, 114 tokens), `dsh-compaction` against `dsh-hook-protocol` (12 lines, 74 tokens), and `dsh-hook-protocol` against `dsh-user-approval` (12 lines, 79 tokens). Three more companions carried the same text just under jscpd's 6-line / 60-token floor, and `dsh-tool-todo` carried it behind a `jscpd:ignore` marker until [the marker note](2026-09-03-duplication-suppression-that-suppressed-nothing.md) removed the suppression mechanism. The gate was reporting an arbitrary subset of one repeated design.

The [hook bridge extraction](2026-09-03-hook-bridge-and-invariant-plumbing-extraction.md) deferred these three clones and named the ownership question this note answers; its "Deferred" section is superseded here.

Two gates disagreed about part of that text. `verify-package-invariants` requires every one of the 261 companions to close its installer with `}, { inject: ['sessions'] })` and to register through `ctx.invariants.register(PACKAGE_NAME, install)` using those exact identifiers; its AST rule rejects any other spelling. `bun run duplication` rejects repeated text. One gate mandates verbatim text that the other forbids, and neither yields: the registration tail cannot be shortened, renamed, or parameterised.

## Decision

### `dsh-session` owns the plumbing

`@deepseek-ai/dsh-session` declares `Session`, `SessionEvent`, `session/created`, and `session/event`, and is a peer dependency of all six product packages. It publishes the shared plumbing at [`./invariant-staging`](../../../../packages/core/session/src/invariant-staging.ts), a module that owns its exports rather than forwarding them.

`stageSessionEvents(ctx, fail, staging)` installs the three listeners as `ctx.on` effects on the calling fiber, keeps the state and staging tables, seeds every session the store already holds, seeds each announced session, and adopts a session first observed at dispatch. The `SessionEventStaging` steps belong to the owner:

- `seed(session)` builds committed state from the events a session already holds;
- `publish(state, event)` advances state that publication commits directly and reports whether the event needs no staged result, which is how a turn cursor still moves on unclaimed events;
- `stage(state, event)` validates a candidate before its append commits and returns what to commit, or `undefined` when the owner ignores the event;
- `claims(event)` decides which published events must have been staged, so a publication that skipped dispatch fails instead of committing silently;
- `commit(state, staged)` folds one staged result and returns the state that becomes committed.

`TState` is constrained to `object` so a seeded session is distinguishable from one never seen; the adoption lookup would otherwise re-seed a nullish state on every event.

The same module owns `advanceOpenTurn` and `OpenTurnCursor`. `turn/start` and `turn/end` are session vocabulary, and `dsh-compaction`, `dsh-hook-protocol`, and `dsh-user-approval` each kept a byte-identical copy of the cursor; their traces now extend `OpenTurnCursor`. `dsh-tool-todo` keeps its own boolean turn flag, which records no turn number and needs no cursor.

### Each package keeps its own relation

No relation moved. `dsh-compaction` keeps its bracket, checkpoint, and turn-boundary rules and its stale-orphan seed repair; `dsh-goal` keeps the strict decoder fold; `dsh-hook-protocol` and `dsh-user-approval` keep their pair vocabularies; `dsh-tool-workflow` keeps its run/member fold; `dsh-tool-todo` keeps its snapshot and turn-enclosure rules; `dsh-session` keeps seq, turn/step enclosure, and tool call/result pairing. Every companion still registers its own `PACKAGE_NAME` through the mandated tail, and no product package depends on another.

The `v8` coverage exclusion that five companions each carried on the unstaged-publication branch is gone: `packages/core/session/tests/invariant-staging.spec.ts` reaches both halves of that guard directly, so the shared module is covered without an exclusion comment.

### The gate tension, measured

Extracting the plumbing is enough; the mandated tail alone does not trip jscpd. Isolating the two most similar residual companions — `dsh-hook-protocol` and `dsh-user-approval`, from their `install` declaration to end of file — leaves a longest shared run of **46 tokens over 11 lines**, from the `commit:` entry through `Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))`. The token floor is 60, so the margin is 14 tokens.

This note first recorded that part of the margin was prose — that jscpd 5 tokenizes comments under `mode: mild`, so each companion's `apply` JSDoc naming its own package broke the run. That is wrong, and the correction is kept here because the wrong version was cited as a maintenance constraint. Measured directly against jscpd on two-file fixtures at this repository's settings: identical code carrying *different* comments still reports one clone, and different code carrying *identical* comments reports none. Comment text neither creates a clone nor breaks one. The 14-token margin is code, and a future companion that copies another's `apply` documentation verbatim introduces nothing.

## Alternatives considered

**Put the plumbing in `dsh-invariants`.** Rejected: the [package-invariant contract](../architecture/2026-07-19-package-invariant-runtime-contracts.md) states that the central service imports no product package, and the plumbing is defined entirely in terms of `Session` and `SessionEvent`.

**Add a `jscpd:ignore` marker or an `.jscpd.json` ignore entry.** Rejected: both suppress the report without removing the repetition, and the in-file suppression mechanism is being removed from the configuration.

**Reshape one companion until it falls under the detector's threshold.** Rejected as threshold-gaming. It leaves seven copies of one design in place and re-fires the moment any of them grows.

**Weaken `verify-package-invariants` so the tail can vary.** Rejected: the exact-name registration and checked local `install` are what make package ownership auditable, and the measurement above shows the tail is not the binding constraint.

**Let the shared module own the replay loop too, folding seeded events through `stage` and `commit`.** Rejected: `dsh-compaction` replays an inherited prefix under a stale-orphan repair rule that has no live counterpart, so a uniform replay would have needed a replay flag threaded through the owner steps or replay-only data parked on the live trace.

**Move each package's relation check into the shared module.** Rejected: product vocabulary, dependencies, tests, and change ownership belong with the package that emits the data, which is the whole point of a package-owned companion.

## Consequences

- One module owns the dispatch/publication split, so a change to how staging works — ordering, adoption, or the fail-closed guard — happens once and every owner inherits it.
- No clone `bun run duplication` reports involves any of the seven companions or the shared module. `dsh-tool-todo`'s previously suppressed clone against `plan/plan-mode` went with it.
- `dsh-session` gains a published subpath that every invariant companion resolves at runtime. It is emitted by `tsc` to `lib/types/invariant-staging.js`, published through the existing `lib/types/**/*.js` entry in `files`, and has no runtime imports, so a packed install resolves it without a bundle entry.
- `packages/core/tools/src/invariant.ts`, `packages/context/time-context/src/invariant.ts`, `packages/llm/llm-retry/src/invariant.ts`, and `packages/goal/goal-round-driver/src/invariant.ts` still hand-roll variants of this plumbing or of the open-turn cursor. They are unconverted and are the next candidates.
- A companion whose `claims` and `stage` disagree now fails loudly at publication with its own `unstagedMessage` instead of committing nothing, and that path is tested rather than excluded from coverage.
