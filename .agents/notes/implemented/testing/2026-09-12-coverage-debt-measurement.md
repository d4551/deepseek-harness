# Agent Note: The coverage debt is measured, not only counted

Status: implemented

English | [中文](2026-09-12-coverage-debt-measurement.zh.md)

## Problem

[Coverage exclusions declare structural or marked debt](2026-09-06-coverage-debt-markers.md) made the debt countable, and the count was the only instrument. Nothing said which marked entries already met the per-file bar, so a file that had reached 100% stayed excluded until someone measured it by hand, and an entry hiding a whole package counted the same as one hiding a single file. Three findings sat outside the count: `packages/experimental/webworker-runtime/src/**/*.ts` was listed beside `src/**`, counting one debt twice while excluding nothing on its own; the platform-conditional lists [`vitest.config.ts`](../../../../vitest.config.ts) spreads in (the win32 package set, the pwsh-less sources, the Windows-only sources) were never read back, so a rename there would leave an entry excusing a path that no longer exists exactly on the platform where it applies; and the markers were spelled `TODO(...)`, the one word the repository contract forbids inside a gate.

Two pieces the gate leans on had no spec of their own: the istanbul reporter that prints the clickable `path:line:col` records under a threshold failure, and the browser-lane discovery in [`vitest.client-browser.ts`](../../../../vitest.client-browser.ts), which parsed every client spec with Babel on every config load whether or not the spec could ever import the accessibility harness.

## Decision

**The markers are `DEBT(gui)`, `DEBT(inspector)`, and `DEBT(webworker)`.** Same lanes, same comment-block parser, same gate; the spelling no longer carries a banned word, and [`docs/testing.md`](../../../../docs/testing.md) names the new spelling.

**`bun run verify-coverage-debt` reads more back.** Beyond the four conditions the prior note lists, it fails on an entry another single entry already covers whole — the later of two equal entries flags, so every flagged glob can be deleted on its own — and on a platform-conditional lane entry naming nothing in the tree. The conditional lists are declared unconditionally in [`vitest-inventory.ts`](../../../../scripts/vitest-inventory.ts) and selected by platform in derived exports, so the check runs on every host. The inventory prints per lane in globs and in files.

**`bun run measure-coverage-debt` measures the debt.** It runs the coverage lane with only the structural and platform-conditional exclusions in force, every threshold at zero, and a tab-separated per-file totals reporter, [`coverage-file-totals.cjs`](../../../../scripts/coverage-file-totals.cjs), whose numbers come from istanbul's own per-file summary rather than a second derivation over the raw range maps. It then places every debt file against per-file 100%: the entries whose files all meet the bar, the files still short in order of distance, and the files no suite loaded. Trailing arguments narrow the run to one package's suites, which is how the entries below were closed on a host that cannot run the whole lane.

**Nineteen entries left the list.** Six named files that already met the bar from their own suites; the duplicate webworker entry excluded nothing; twelve closed through tests written against the measured gaps — the command lifecycle invariant, the Cordis host registry and wire values, the Cordis client guard, the popupSelect shell and command directory, slash-trigger detection, the client-runtime translate double, and the Cordis panel's status, run-card index, and inventory. Three of those closed by deleting dead code the gap named: a `disarmRequest` nobody called, a settle-time re-check that `select` and `confirm` had already made synchronously, and a trigger-character branch the `@` path could never reach.

**Both istanbul reporters print through istanbul's writer and have specs.** The uncovered-locations reporter asks the report context for its console writer instead of `console.log`, its record shapes — implicit branch arms, whole-line statements, declaration-less functions — are pinned, and the totals reporter is pinned the same way.

**Discovery parses only a spec that spells the harness specifier.** A spec that never mentions `@deepseek-ai/dsh-client-a11y` cannot import it, so it costs one file read; the parse still decides between a value import, a type import, and a mention in a comment. Every Vitest config load runs discovery, so the saving lands on every run.

**Transformed modules persist between local runs.** `fsModuleCache` is on outside CI on the root lane and both node projects: Vitest keys the entries by file content and environment config and bypasses the cache inside workers under the v8 provider, so the gate measures uncached source. CI starts from a fresh checkout where nothing survives to be reused.

## Alternatives considered

**Measure inside `verify-coverage-debt`.** Rejected: measurement costs a coverage-lane run, and the static lane must stay static. The two commands share the exclusion reader and nothing else.

**Read the totals from istanbul's JSON reporters.** Rejected: the totals file is five columns of counts, read back with string splits and integer parses that fail loud on any other shape; the JSON reporters would have meant validating a nested document to reach the same five numbers.

**Keep the `TODO(...)` spelling because the prior note documents it.** Rejected: the contract forbids the word in gates, and the note is a dated record, not the current reality; it now points here.

**Enable the transform cache in CI too.** Rejected: nothing persists between CI jobs, so the cache would only pay the write.

## Consequences

The ratchet has two readings now: `verify-coverage-debt` prints how many globs and files each lane hides, and `measure-coverage-debt` says which entries can go. An entry left in the list is either short of the bar by a stated number of items or unmeasured because no suite loads the file, and both readings come from the same exclusion reader the gate uses.

`packages/interaction/commands/src/index.ts` stays listed on one containment path — the warning written when the `command/done` append itself fails — which no suite reaches without a session that refuses an append; `packages/session/session-projection/src/index.ts` stays with the remaining `DEBT(gui)` entries. The client-browser project's contribution was not measured here: the measurement ran the node projects only, so every entry removed was at the bar from those alone, and the gate's aggregate can only add to that.
