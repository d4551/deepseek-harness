# Agent Note: A gate for test cases that pass whether or not the code works

Status: implemented

English | [中文](2026-09-03-assertionless-test-gate.zh.md)

## Problem

A test case that reaches no assertion passes on a green tree for a reason unrelated to the behavior its title names. `packages/api/session-controller/tests/manager.client.spec.ts` held the canonical example: "ignores Host status and error events for sessions without an instance" called `manager.handleSessionStatus(S2, true)` and `manager.handleSessionError(S2, '无实例')` and asserted nothing, so it passed whether or not either call was safely ignored. Nothing in the stack reported it. `syntax-duplication` reads test titles but not bodies, coverage counts executed lines rather than checked outcomes, and oxlint's `expect-expect` equivalent is not in its rule set.

A regex prototype produced 337, then 264, then 63, then 41 findings as successive pattern bugs were fixed, and every count was wrong. Line-oriented matching cannot separate `it.each(rows)(…)` from `test.ctx.on('goal/changed', cb)`, cannot tell a case body from the helper module that holds its assertions, and cannot see that `it('name', importedCase)` delegates at all.

## Decision

[scripts/no-assertionless-tests.ts](../../../../scripts/no-assertionless-tests.ts) walks the TypeScript 7 AST (`typescript/unstable/ast`, batched through the shared [ts7-session](../../../../scripts/ts7-session.ts) the way `syntax-duplication` batches) and reports three finding kinds:

- **`empty-body`** — the case body holds no statements.
- **`no-assertion`** — the body runs code and reaches no assertion, so only a thrown exception can fail it.
- **`callback-only-assertion`** — every assertion sits inside a listener callback (`.on(…)`, `.subscribe(…)`) that nothing in the case forces to run, so the case passes when the event never fires.

[scripts/no-assertionless-tests.spec.ts](../../../../scripts/no-assertionless-tests.spec.ts) is the gate: injected red/green fixtures for each kind and each accepted form, then a live sweep asserting the tracked corpus is clean, in the same executed-lane form as `no-barrels.spec.ts`. `scripts/**/*.spec.ts` is already a vitest project, so `bun run test` enforces it.

Resolution is call-target aware, which is what a regex cannot be:

- **A runner call is `it`/`test` reached only through vitest modifiers** (`only`, `skip`, `todo`, `fails`, `concurrent`, `sequential`, `each`, `for`, `runIf`, `skipIf`, `extend`), one or more links deep, including the invoked `it.each(rows)(…)` form. Any other member name ends the chain, so `test.ctx.on(…)` — 26 live occurrences — is no case. A module that binds `test` itself (`const test = await bench({…})`) shadows the runner for that file.
- **Delegation resolves three levels**, into same-module declarations and into modules imported over a relative path, including renamed specifiers. `packages/typert/generator/tests/type-model.spec.ts` registers 36 cases as `it(title, importedCaseFunction)`; each resolves to the `type-model-cases-*` module that asserts.
- **A registration helper is not a case.** `itInScratch(name, run)` in `packages/util/atomic-write/tests/atomic-write.spec.ts` builds a body from its own parameters, so the assertions belong to call sites this module cannot see.
- **A throwing Testing Library query is an assertion.** `screen.findByText(label)` rejects when the label never appears, so it decides the case exactly as `expect` does; `queryBy*` answers `null` and decides nothing, so it does not.

`it.todo(…)` and the title-only `it('name')` registration are exempt: both are bodiless by design.

## What the sweep found

Twenty-eight cases across twenty-two packages, all true positives, all now asserting the consequence their titles name. The largest family was the invariant companions: `accepts <a valid sequence>` cases that emitted or appended a lawful event sequence and checked nothing, so they passed even against an invariant that observed none of it. Each now asserts the state the accepted sequence left behind — the workflow trace was retired, the approval pair consumed its open question, the tool executions left the stage table — which fails when the invariant is not tracking. The empty invariant companions (`packages/e2b/*`, `packages/storage/storage-json`) assert the package-name reservation is held while mounted and released on disposal, matching the idiom already in `packages/api/settings-controller/tests/invariant.spec.ts`.

The rest were single cases: a database file whose mode was never re-read, a stray JSON-RPC response that now proves the next real request still settles, a `dispose()` idempotence case that now pins the settled result across both calls, and an HMR watcher pair whose `eventually(…)` waits are now followed by an assertion on the exact observed states.

No case was deleted, weakened, or exempted, and the gate carries no allowlist.

## Alternatives considered

**Keep the regex prototype.** Rejected: four successive counts, each confidently wrong. The two errors that mattered — matching arbitrary `test.<member>(…)` chains, and reporting every suite that registers imported case functions — are not fixable by a better pattern, because both require resolving what a call names.

**Report any case lacking an inline `expect`, and exempt the delegating suites by path.** Rejected: an allowlist keyed on paths goes stale the moment a suite moves, and it hides exactly the cases the gate exists to find. Resolving the delegation costs one AST walk per unresolved case and is exact.

**Count any resolved helper containing a `throw` as asserting.** Tried and rejected: it silenced eight findings, of which only two were genuine assertion helpers. `makeBridgeHarness()` and `startMux()` throw on fixture problems, so the rule exempted every case that touched a harness. The assertion vocabulary stays closed instead, and `eventually(predicate, message)` callers now assert their observation explicitly — which is stronger than the wait alone.

**Report an assertion reachable only through any callback.** Rejected: an arrow passed to `waitFor`, `map`, or `forEach` normally runs, and reporting those would bury the one shape that genuinely does not. Only subscription methods (`on`, `once`, `subscribe`, `addEventListener`, and their relatives) qualify, and only when the case has no other assertion at all.

**Add the check to oxlint.** Rejected: oxlint's rule set is fixed by its Rust binary, so a repository-local rule is not installable there — the same constraint that put `syntax-duplication` in an executed spec.

## Consequences

Every `it`/`test` case in `packages/*/*/tests/**`, `apps/*/tests/**`, and `scripts/**` must now reach an assertion, and a new no-op fails `bun run test` rather than passing quietly. The sweep costs one batched parse of about 1200 spec files (~5s), plus a lazy parse of each helper module a case delegates to; only cases without a direct assertion pay for resolution.

Three limits are deliberate and are new decisions rather than bugs. Delegation stops at three levels, so an assertion at the fourth is reported. A helper reached through a value the module cannot resolve — a method on a constructed object, a bare-specifier import — does not exempt its caller, which is what keeps `manager.handleSessionStatus(…)` reported. And the gate judges reachability, not strength: `expect(() => run()).not.toThrow()` satisfies it. Tightening any of these is a separate change with its own red/green fixture.

`packages/client/ui-attachment/tests/message-image.client.spec.tsx` names the one case whose discriminating power is bounded by its subject: React 19 ignores a state update after unmount silently, so "ignores a load settling after unmount" can assert that each arm loaded once and rendered nothing, but no observable distinguishes the guarded component from an unguarded one.
