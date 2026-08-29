# Agent Note: Mutation testing as the coverage counterweight

Status: implemented

English | [中文](2026-06-11-mutation-testing.zh.md)

## Problem

The per-file 100% coverage gate ([the quality-gates decision](../process/2026-06-11-quality-gates.md)) proves every line *executes* under test — not that any assertion would notice if the line were wrong. Under agent-written tests, coverage pressure can produce execution-without-assertion. Mutation testing measures what coverage cannot: whether the suite *kills* deliberately injected bugs.

## Decision

Stryker runs over `packages/util/*/src` with the Vitest runner, configured in [stryker.config.mjs](../../../../stryker.config.mjs) and invoked as `bun run mutation`.

- **Scope is the ratchet.** The zero-dependency utility tier is the code every other package builds on, so it goes first; the scope widens tier by tier as each one reaches its threshold.
- **The suite is scoped with the mutants.** [vitest.mutation.config.ts](../../../../vitest.mutation.config.ts) includes only the tests owned by the packages under mutation. A mutant a consumer's suite would have killed therefore survives here, so the scoping can only lower the score, never inflate it.
- **`coverageAnalysis: 'all'`, not per-test.** These suites reach their subject through tsconfig path aliases, which Stryker's per-test coverage attribution does not follow: it reported mutants as survived that fail the suite when applied by hand.
- **`break` sits one mutant below the recorded score, and only moves up.** The scope measures 96.20 — 778 killed plus 7 timed out of 816 reachable mutants. One mutant is worth 0.1225 points here, so the threshold is 96.1: losing a single kill scores 96.08 and fails the run.

## What the survivors are

The 31 survivors are not missing assertions; they are mutants no assertion over the public result can reach, and the distinction is what keeps the number meaningful:

- **Memory-bounded, output-identical.** `TextRetainer`'s suffix trim keeps the accumulator inside `suffixCap`. Its own comment records that `finish()` never reads past the last `suffixLen` bytes, so removing or inverting the trim changes allocation and nothing a caller can observe.
- **No-ops by construction.** `clearTimeout(undefined)` does nothing, a second `[Symbol.dispose]()` does nothing, and `mkdir({ mode: undefined })` is the platform default.
- **Guards subsumed by the check that follows.** The UTF-8 scanner's bounds guards are redundant with the sequence-length test after them; three such guards in `abbreviateHomePath` were genuinely redundant and were deleted rather than annotated.
- **Bounds on work, not output.** The UTF-8 scanner's scan-back cap keeps a long continuation run from being walked end to end; how far it walks is invisible to what it returns.
- **Off-platform.** The Windows file-as-parent probe needs Windows to fail the way it guards against.

Raising the score past this means deleting the code the survivors sit in or widening the scope — never excluding a file, loosening the threshold, or annotating a mutant the suite could have killed.

## Alternatives considered

**Mutate `packages/*/src` from the start.** The whole-repo scope is what the score should eventually mean. It is not where it can start: 1590 source files under mutation, each mutant re-running a suite, is not a signal anyone waits for, and a first number nobody can act on teaches nothing.

**Run the full suite as the mutation suite.** Every mutant would then be checked against every consumer test, which is strictly more killing power. It also means a 17k-test run per mutant; the scoped suite runs in about a second, which is what makes 820 mutants measurable at all.

**Annotate the equivalent mutants and set the threshold at 99.** Stryker supports disable comments, and each survivor above could carry its proof. It would buy a rounder number in exchange for a file of exclusions that a later reader must re-verify, and for the standing temptation to reach for one whenever a mutant is merely inconvenient. The recorded score with the survivors explained is the more honest artifact.

**Leave `break` at 99 while the score is 95.61.** A gate that cannot pass is not a gate; it trains everyone to ignore a red run.

## Consequences

Surviving mutants are work items with a shape: pick one, write the test that kills it, repeat. That loop took this scope from 82.92 to 96.20 and produced tests for real behavior that had none — UTF-8 cut boundaries, LaunchServices parsing, temp-file exclusivity, name folding, the writer lock's deadline and backoff, and a thrown null reaching its caller intact — plus three code simplifications the survivors exposed, and one narrowed `try` that had been swallowing this package's own parser failures as an absent macOS record.

Adding the lane moved `docs/testing.md`'s word ceiling from 1150 to 1200: the tier list gains a lane, and the coverage tier now describes every kind of exclusion its gate carries instead of naming only the `pwsh` one, which read as though it were the only exemption.

`bun run mutation` runs in `ci-primary`, `ci-linux-primary`, and `check-all`, and `run-gates.spec.ts` asserts that membership: a threshold nothing executes is a number, not a ratchet.

Not built: the nightly job that records the score over time, and the PR-scoped incremental run that would replace the whole-scope run once the scope is wide enough for that to matter.
