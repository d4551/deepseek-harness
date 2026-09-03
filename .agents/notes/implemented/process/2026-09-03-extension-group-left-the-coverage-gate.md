# Agent Note: A whole package group left the coverage gate under someone else's comment

Status: implemented

English | [中文](2026-09-03-extension-group-left-the-coverage-gate.zh.md)

## Problem

`vitest.config.ts` states the rule directly above its thresholds: "100% or it doesn't merge", per-file "so a well-covered big file can't subsidize a bare one", and "Every v8 coverage exclusion comment must state its reason."

Two lines in that exclusion list were `packages/extensions/*/src/**/*.ts` and its `.tsx` twin. They sat at the end of a block introduced by "Slash/command/input round: per-file gaps deferred with the same client-lane debt", which describes eleven named client slash-command files and describes none of `packages/extensions` — a different group holding the Cordis Host and Client runners, the `cordis_inspect` tool, and its browser cards. The glob inherited a comment about something else, so the exclusion had no reason of its own and read as part of an unrelated batch.

What it covered, measured before changing anything: 45 files at 57.91% statements. Fifteen at zero, including every source file of `tool-cordis` — a model-facing tool — and of `ui-cordis`. `cordis-client-runner/src/client/timer.ts` at 3.79%, `cordis-host-runner/src/inspect-registry.ts` at 3.73%.

The open end mattered more than the number. A glob excuses files that do not exist yet, so every file added anywhere under `packages/extensions/` left the gate on creation, silently.

## Decision

The glob is replaced by the 33 files that do not meet all four thresholds, listed one per line, under a comment that states what it excludes and the number measured when it was written. The twelve files that already meet every threshold are now gated, and a file added to the group is gated by default because no pattern covers it.

The enumeration is against all four metrics, not statements alone. A first pass filtered on statements and let two files through that the gate rejected on branches — `ui-cordis/src/client/card-model.ts` at 100% statements and 84.9% branches, and `ui-cordis/src/index.ts`, which never loads under any suite and so appears in no summary at all while the gate reads it as zero.

## Alternatives considered

**Bring the group to 100% now.** Fifteen files are at zero and two packages have almost no suite; that is a project, not an edit. Enumerating first makes the debt visible and finite, and each file leaves the list when its tests land.

**Give the glob its own comment and keep it.** It would fix the misattribution and keep the open end — the part that lets an unwritten file skip the gate. A stated reason for an unbounded exclusion is still an unbounded exclusion.

**Exclude the two packages with no real suite and gate the two runners.** `cordis-host-runner/src/index.ts` is at 79% and `guard.ts` at 70.93%, so the runners do not pass either; the split would be drawn where the packages are rather than where the coverage is.

## Consequences

`packages/extensions` is in the coverage gate. Twelve files are held at 100% on all four metrics, 33 are named as debt, and a new file in the group is gated unless someone adds a line saying otherwise. Verified by running the gate scoped to the group: zero threshold errors naming `packages/extensions`.
