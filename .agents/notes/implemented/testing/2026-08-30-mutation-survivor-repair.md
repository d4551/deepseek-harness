# Agent Note: Mutation survivors die by test or by deletion

Status: implemented

English | [中文](2026-08-30-mutation-survivor-repair.zh.md)

## Problem

The utility tier's mutation gate recorded 96.58 of 818 with 28 survivors, and `break` sat at 96.5 — the last honestly measured floor — because that score could not be reproduced. A threshold below the recorded score lets every survivor between the two numbers land while the run still reads green. The survivors fell into two kinds: assertions that never reached the mutated branch, and guards that no input could distinguish from the code around them.

## Decision

Every survivor is either killed by a test that reaches the mutated branch, or deleted when the guard it mutates is redundant with the logic beside it. The [mutation-testing decision](2026-06-11-mutation-testing.md) owns the gate's design — a recorded score with explained survivors, never an exclusion list; this note records the round that executed it.

- **atomic-write pins the mkdir call itself.** The mock now records every `mkdir` invocation, and a test asserts the exact options object each `dirMode` case passes: `{ recursive: true }` when no directory mode is requested, `{ recursive: true, mode }` when one is. The multi-level `dirMode` test creates two missing levels and asserts both carry the requested mode, so a mutant that drops the mode from any one level fails.
- **home-paths answers ENOENT for the whole ancestor chain, root included.** The mocked `realpath` refuses every segment of a path, so the walk reaches its `parent === current` guard and rethrows instead of descending forever. The guard's coverage-ignore comment came out with the test that covers it.
- **Redundant guards are deleted, not annotated.** `trimTrailingPartialUtf8`'s three early returns (empty buffer, out-of-bounds walk stop, zero-length sequence) all collapse into the final length comparison: an out-of-bounds byte reads as `undefined`, `undefined & 0xc0` is 0, the walk exits at −1, and the comparison returns the input untouched. `createLaunchEnvironmentSnapshot` stores each layer's `path` unconditionally and the read side keeps the omit-when-undefined normalization, so the write-time ternary and the optional-chaining it fed had no observable job left.
- **The threshold rides the measured score.** The fresh run measures 99.08 of 764 (757 detected: 750 killed, 7 timed out; 7 survived, 0 without coverage). One mutant is 0.131%, so `break` sits at 98.9: one new survivor still passes, a second fails the run.
- **The seven remaining survivors are each equivalent in context.** The full equivalence arguments live in this note; [stryker.config.mjs](../../../../stryker.config.mjs) names them beside the threshold: a lock-contention catch arm whose sole call site reads truthiness — an emptied catch returns `undefined`, falsy exactly like the `false` it replaces — a loop bound whose extra iteration slices an empty range, a case-fold whose two call sites fold symmetrically (divergence is reachable only for non-ASCII Windows name pairs the contract is silent about, where neither folding matches the native table), a regex replacement whose block is extracted by a later regex regardless, a missing-block early return whose subsequent match returns the same `undefined`, an out-of-bounds walk exit, and a lead byte the continuation walk cannot stop on.

## Alternatives considered

**Raise the threshold without touching the survivors.** Rejected: averaging survivors away is exactly what the ratchet forbids, and the gap between break and the recorded score is the number of regressions the gate would wave through.

**Exclude the equivalent mutants in the Stryker config.** Rejected: an exclusion list is a standing temptation to reach for whenever a mutant is merely inconvenient, and it hides future non-equivalent mutants on the same lines. The [mutation-testing decision](2026-06-11-mutation-testing.md) already rejected per-line annotations for the same reason.

**Keep the redundant guards and explain their mutants.** Rejected: a guard no input can reach is dead code whose mutants are permanently unkillable; deleting it removes the debt and the survivors together.

## Consequences

The utility tier measures 99.08 with `break` 98.9, and the seven survivors carry their equivalence arguments in this note. A new survivor fails the run on the second occurrence. The home-paths root guard is covered by a test rather than a coverage-ignore comment, so the line's coverage is asserted, not assumed.
