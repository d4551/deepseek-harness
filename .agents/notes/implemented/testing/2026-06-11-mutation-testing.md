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
- **`break` sits one mutant below the recorded score, and only moves up.** The scope measures 96.92 — 780 killed plus 7 timed out of 812 reachable mutants. One mutant is worth 0.1232 points here, so the threshold is 96.8: losing a single kill scores 96.80 and stays above it; losing two scores 96.67 and fails the run.

## What the survivors are

The survivors are not missing assertions; they are mutants no assertion over the public result can reach, and the distinction is what keeps the number meaningful:

- **Memory-bounded, output-identical.** The suffix accumulator now retains exactly the window `finish()` reads, so the *old* trim survivors are gone — that refactor made the retention arithmetic load-bearing output logic and took the scope from 96.57 to 96.92. What remains in this class are bounds on work rather than output: the UTF-8 scanner's scan-back cap, and the fast-path gate that keeps the head strategy out of the suffix arithmetic.
- **No-ops by construction.** `clearTimeout(undefined)` does nothing, and a second `[Symbol.dispose]()` on the watchdog is now guard-free and idempotent by construction (timeout measures 100.00). `mkdir({ mode: undefined })` is the platform default. An emptied `catch` belongs here too: it returns `undefined` where the caller only tests falsiness, so the explicit `return false` reads as the intent rather than as behaviour.
- **Guards subsumed only through undefined-arithmetic.** The `i < 0` and `expected === 0` returns in the trailing-sequence trimmer could be deleted — a negative index reads `undefined`, every comparison yields `NaN`, and the code falls through to the same result — but relying on that is exactly the obscurity the guards exist to prevent, and deleting spec-stating returns to move a number is removal-chasing, not cleanup.
- **Coerced, not thrown.** `RegExp.exec(undefined)` matches against the string `"undefined"` instead of throwing, so the LaunchServices guard that returns early on an absent block is unobservable: without it the next match simply finds nothing and the caller falls back either way.
- **Direction no surface exposes.** Windows name-folding stores and looks up by the *same* key on both sides of `get`/`getFrom`, and the folded key never crosses the public surface — `toUpperCase` versus `toLowerCase` is indistinguishable to every caller, so the folding test proves consistency, not direction.

Raising the score past this means widening the scope — never excluding a file, loosening the threshold, or deleting a bound the code legitimately keeps.

### Why 99 is not reachable on this scope

99 needs the survivors at or under 1% of the reachable mutants — eight of 812. There are 25, and they are the equivalent floor listed above: every remaining survivor is an alternate form of correct code (a bound, a fast path, an intent return, a falsy-versus-undefined catch, an unexposed fold direction, a loop or spread boundary whose mutant stores or spreads an empty value). Killing one means either deleting code that is correct and intentional — the thing this note exists to refuse — or widening the scope.

The earlier claim that the suffix-trim survivors could only be killed by exposing a reading no consumer needs was wrong, and the exact-window refactor is what refuted it: making retention exact, rather than over-retaining and re-slicing, deletes the redundant re-derivation in `finish()` and turns the accumulator arithmetic into output. That bought 0.35 points and proved the honest path is exhausted when the survivors stop being alternate forms of observable behaviour.

## What widening can and cannot buy

An aggregate of 99 requires the overall survivor rate to fall below 1%, so each added tier has to arrive under that rate or it costs more than it contributes: at survivor rate `r` and `N` added mutants, `N * (0.01 - r) >= 22.84`, which no `N` satisfies once `r` reaches 1%.

Both measured scopes sit above it. This one runs at 3.43% (28 of 816). `tool-todo`, measured as a second scope, arrived at 12.00% and reached 4.00% after tests that pinned its whole model-facing description, its parameter and output schemas, `counts.completed`, the companion's plugin name, and the turn boundary across an unrelated event — 22 mutants, every one a contract nothing had asserted. Of its remainder, four are provably equivalent: a `typeof` guard the status-set check already subsumes, `{}` for `{ open: false }` where the field is only read for truthiness, and the trace cache, which recomputes the same trace when it is skipped.

So widening is bounded by the equivalent-mutant floor, not by test effort: a tier admitted below the threshold lowers the number, and the achievable aggregate is roughly one minus that floor. Widening is worth doing for the defects it surfaces, which is what it bought here, and not as a route to a target the floor puts out of reach.

## Alternatives considered

**Mutate `packages/*/src` from the start.** The whole-repo scope is what the score should eventually mean. It is not where it can start: 1590 source files under mutation, each mutant re-running a suite, is not a signal anyone waits for, and a first number nobody can act on teaches nothing.

**Run the full suite as the mutation suite.** Every mutant would then be checked against every consumer test, which is strictly more killing power. It also means a 17k-test run per mutant; the scoped suite runs in about a second, which is what makes 820 mutants measurable at all.

**Annotate the equivalent mutants and set the threshold at 99.** Stryker supports disable comments, and each survivor above could carry its proof. It would buy a rounder number in exchange for a file of exclusions that a later reader must re-verify, and for the standing temptation to reach for one whenever a mutant is merely inconvenient. The recorded score with the survivors explained is the more honest artifact.

**Leave `break` at 99 while the score is 95.61.** A gate that cannot pass is not a gate; it trains everyone to ignore a red run.

## Consequences

Surviving mutants are work items with a shape: pick one, write the test that kills it, repeat. That loop took this scope from 82.92 to 96.57, and the exact-window suffix refactor then took it to 96.92 while driving `timeout` to 100 — producing tests for real behavior that had none — UTF-8 cut boundaries, LaunchServices parsing, temp-file exclusivity, name folding, the writer lock's deadline and backoff, and a thrown null reaching its caller intact — plus code simplifications the survivors exposed, and one narrowed `try` that had been swallowing this package's own parser failures as an absent macOS record.

Adding the lane moved `docs/testing.md`'s word ceiling from 1150 to 1200: the tier list gains a lane, and the coverage tier now describes every kind of exclusion its gate carries instead of naming only the `pwsh` one, which read as though it were the only exemption.

`bun run mutation` runs in `ci-primary`, `ci-linux-primary`, and `check-all`, and `run-gates.spec.ts` asserts that membership: a threshold nothing executes is a number, not a ratchet.

The same spec asserts the gate's label carries the tier it measures. This scope is 9 of the repository's 248 packages, so a CI line reading `mutation score` reports the repository's score to anyone scanning the run, and that is not what passed. The label reads `mutation score (util tier)`, and restoring the unscoped one fails the spec.

Not built: the nightly job that records the score over time, and the PR-scoped incremental run that would replace the whole-scope run once the scope is wide enough for that to matter.
