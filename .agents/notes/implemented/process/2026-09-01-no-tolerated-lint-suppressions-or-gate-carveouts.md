# Agent Note: An unused lint suppression fails, and the TypeScript 7 scans carry no path carve-outs

Status: implemented

English | [中文](2026-09-01-no-tolerated-lint-suppressions-or-gate-carveouts.zh.md)

## Problem

The TypeScript 7 conversion left two tolerances behind, and each one hid work from a green gate. `.oxlintrc.json` reported an unused `oxlint-disable` directive as a warning, so a directive that no longer suppresses anything survived every passing lint run and every CI job. `scripts/typescript7-unstable-api.spec.ts` narrowed both of its tracked-tree scans with pathspec exclusions — `patches/*` on the compiler-API scan, `goal/` on the compatibility-package scan — and the comment on the `goal/` exclusion asserted that those plan records state the opposite acceptance criterion.

## Decision

`.oxlintrc.json` carries no rule set to `"off"`. Every per-file-class exemption is gone: the shared source block no longer silences `no-empty-object-type`, `no-invalid-void-type`, `no-namespace`, or `no-void`; the `examples/**` and webworker Node-stub blocks no longer silence `require-await` or `no-extraneous-class`; the TypeGraph fixture blocks no longer silence `no-explicit-any` or `@stylistic/quotes`; and the tests block no longer silences `no-non-null-assertion`, `no-unnecessary-condition`, `only-throw-error`, `require-await`, or `restrict-template-expressions`. The code moved to satisfy the rules instead.

An unused disable directive also fails the gate: `reportUnusedDisableDirectives` is `error` in the root profile, and the executable contract in `scripts/oxlint-contract.spec.ts` pins the failing exit status. The project-free staged profile overrides it to `allow`, because a pass that does not load a rule cannot tell whether that rule's suppression is used.

Satisfying `require-await` and `use-unknown-in-catch-callback-variable` without a suppression changed three asynchronous seams. The webworker runtime's `node:fs`, `node:fs/promises`, and module-seam faces run their synchronous work through `settled` (`packages/experimental/webworker-runtime/src/settled.ts`), which keeps a synchronous throw arriving as a rejection; its directory iterators are explicit async iterators rather than `async *` generators that never await. `dsh-atomic-write` reads and writes through callback-style `node:fs`, whose completion callback carries a typed `NodeJS.ErrnoException`, so no rejection callback and no `catch` variable appears; its writer lock releases synchronously through `rmSync`.

Both TypeScript 7 scans read the whole tracked tree. The only surviving pathspec exclusion is the gate file itself, which carries the banned import forms and the banned package name as test data. Neither removed exclusion was load-bearing: `patches/` holds only `.patch` files, which no source glob in the compiler-API scan matches, and no `goal/` record matches the compatibility-package specifier patterns. The claim in the removed comment was false, and the exclusion it justified was hiding scan coverage rather than buying it.

## Alternatives considered

**Keep unused directives at `warn`.** Rejected: a warning that no gate reads is a record of a defect, not a check. The tree carries no unused directive today, so the level is what keeps it that way; the warning would only tell a later reader that one had been tolerated.

**Keep the per-file-class rule exemptions and fix only the gate carve-outs.** Rejected: an exemption keyed on a path glob silences a rule for code nobody has read. Every one of the fourteen turned out to be satisfiable — the twenty-two violations they were hiding in `scripts/**`, plus sixty-three in the webworker runtime and five in `dsh-atomic-write`, are all fixed in code.

**Delete the stale directives by hand and leave the level at `warn`.** Rejected for the same reason: there are none to delete, and hand auditing does not survive the next suppression that outlives its rule.

**Inherit `error` in the staged profile too.** Rejected on measurement: the project-free profile then reports 117 unused directives across the tree, every one of them naming a type-aware rule the profile does not load. That is the profile misjudging directives it cannot evaluate, not a finding.

**Keep the `goal/` and `patches/*` exclusions and correct only the comment.** Rejected: the exclusions exclude nothing, so they are pure scan narrowing. A pathspec carve-out in a ban gate is the mechanism by which the next real violation lands unseen.

## Consequences

`bun run lint` runs every rule against every owned file with no per-path exemption, and fails on a directive that suppresses nothing, so neither a rule exemption nor a stale suppression can outlive review. Two behaviors changed with the code: `dsh-atomic-write` captures a non-Error rejection as an `Error` rather than rethrowing the raw value, and its lock release no longer awaits an asynchronous removal. The pre-commit hook stays quiet on those directives because the staged profile sets `reportUnusedDisableDirectives` to `allow` in its own `options` block; `extends` otherwise carries the root `error` into a pass that loads no type-aware rules, which is the misjudgment measured above rather than a finding. The two TypeScript 7 scans cover every tracked source file and every tracked file respectively, so the root manifest, `bun.lock`, and the `goal/` plan records are all inside the compatibility-package ban. The [Oxlint decision](2026-07-29-oxlint-linter.md) recorded the warning level this note reverses; the [TypeScript 7 compile pin](2026-08-29-typescript-7-compiler.md) owns the ban itself.
