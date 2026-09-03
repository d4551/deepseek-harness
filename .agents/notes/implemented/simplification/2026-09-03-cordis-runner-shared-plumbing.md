# Agent Note: The cordis runner's repetition is extractable; one guard twin is not

Status: implemented

English | [中文](2026-09-03-cordis-runner-shared-plumbing.zh.md)

## Problem

Removing `.jscpd.json`'s in-file suppression ([the marker note](2026-09-03-duplication-suppression-that-suppressed-nothing.md)) surfaced eight clones in the three cordis extension packages. They split into two kinds that look alike and are not alike.

Four sat inside one authored file, `cordis-host-runner/src/index.ts`. Five service methods each rebuilt the same source-free Plugin row by hand: `[...plugin.packages.values()].map(...)` in `inventory`, `snapshot`, and `inspectPlugin`, and the `currentPackageId`/`nextPackageId`/`activeRun`/`latestRun` tail in `inventory`, `reference`, and `inspectPackage`. Three private steering methods each re-ran the same claim-agent-steer sequence around a different message. Nothing separated the copies; the key order was the only thing they had to agree on, and agreement was maintained by hand.

The other four span the Host and the Client plane: the two `providers.ts` inspect-provider factories, the two guard proxies, and `errorDetails` in `cordis-host-runner/src/index.ts` against its twin in `cordis-client-runner/src/client/runtime.ts`. Each pair is identical model-facing behavior written twice on purpose, and `cordis-host-runner/src/guard.ts` already said so in prose: "Folding them together is not available — the two halves compile in separate programs where `Context` merges different service keys."

## Decision

The four self-clones are extracted. `cordis-host-runner/src/projection.ts` owns every source-free projection of a live Plugin — `packageSummaries`, `versionPointers`, `activeRunPointer`, `latestRunPointer`, and the `lifecyclePointers` fold of the last three — plus the private `cloneAttempt` that detaches an attempt from registry state. Emission order is now a property of the fold rather than of five call sites: `snapshot` still emits its version pointers before `packages` and its Host-only `activeRun` in place of the plain one, and it composes those from the same parts. `steerRuntimeFailure` owns claim-then-resolve-then-steer for the handler and guard reports, and `steerUserContext` owns the plugin-attributed `agent.steer` envelope for all four steering paths, mirroring the `injectUserContext` that already existed beside it.

The four cross-plane clones stay. A shared owner for them would have to be a module both planes import at runtime, and no module inside these three packages can be one. The shipped client bundle rejects it: `dsh-client-bundle-purity` in `packages/client/tsdown.client.ts` throws on any `@deepseek-ai/` **value** import from a browser bundle that is not a module-table row, a vendored library, a generated `/remote` contribution, or a name in `INLINE_SAFE`. Exercising that predicate directly rejects `@deepseek-ai/dsh-cordis-host-runner` and every subpath of it except the generated `/remote`. Type-only imports are erased before the gate sees them, which is exactly why `cordis-client-runner` already reads the runner's wire vocabulary through `@deepseek-ai/dsh-api-remotes/client` and imports no value from a Host package. The reverse direction is worse: the Host would take a runtime dependency on the browser half it serves, and `cordis-client-runner` publishes only its bundle and its declarations.

## Alternatives considered

**Put the shared plumbing in `cordis-host-runner` and import it from the browser half.** This is the module the two planes want, and `INLINE_SAFE` describes its category — "contract layers and pure folds a client bundle may inline". Making it work needs one subpath added to that allowlist, scoped like the existing `@deepseek-ai/dsh-token-meter/client$` entry. That allowlist is an owned bundling decision outside these packages, so it is a decision to take deliberately, not a side effect of a duplication fix.

**Own it in `cordis-client-runner` and import it from `tool-cordis`.** Rejected: it inverts the layering, and the Client package's `files` publishes no importable JavaScript for a Node consumer.

**Rewrite one side so the two stop matching.** Rejected. The Host and Client inspect surfaces are one model-facing contract; expressing it two different ways to satisfy a text comparison makes the pair harder to keep in agreement and states an asymmetry that does not exist.

**Generate both copies, as `api-catalog.ts` already is.** This is the repository's existing answer to the same problem, and it would move these regions into the generator's output where a path exemption covers them. It belongs to `scripts/gen-cordis-inspect-catalog.ts`, not to the packages.

## Consequences

`bun run duplication` no longer reports any clone inside `cordis-host-runner/src/index.ts`; the file lost 172 lines of hand-repeated projection and steering. The four cross-plane clones still reported at that point, unsuppressed and visible, pending the allowlist question above; the follow-up below decides it and extracts three of them. No behavior changed — the projections emit the same keys in the same order, the steering messages and their one-report-per-failure claim are unchanged, and `packages/extensions` tests pass unmodified.

## Follow-up: the allowlist question, decided

Three of the four cross-plane clones are now extracted; the guard twin stays, with a corrected reason.

**The subpath.** `cordis-host-runner/src/wire-values.ts` is the value half of the client-safe wire vocabulary its `./types.ts` declares: `errorDetails`, the JSON Schema constants of the Service and Event inspect queries, `exactInput`, `readExact`, and `inspectProvider`, which pairs a one-method manifest with the caller's own handler. It also holds `CTX_VERBS`, `TIMER_VERBS`, and `ctxVerbForwarder`, the guard rule below, which is here rather than in a sibling because the allowlist entry is anchored on this one module. It imports two types and nothing else, reaches no Cordis service, no Node module, and no browser API, and its emitted JavaScript carries no import at all. It is published as `./wire-values` off `lib/types/wire-values.js`, the same way `./types` is published, so no tsdown entry and no `files` change were needed. `cordis-host-runner/src/index.ts`, `tool-cordis/src/providers.ts`, and `cordis-client-runner`'s `src/client/providers.ts`, `runtime.ts`, and `orchestrator.ts` all build these records from it; `cordis-client-runner` gained the workspace dependency and the project reference, which its Client face already had precedent for — `api/remotes`' Client leaf references this same Host package for `./types`.

**The allowlist edit.** `INLINE_SAFE` in `packages/client/tsdown.client.ts` gained one anchored alternative, `@deepseek-ai/dsh-cordis-host-runner/wire-values$`, scoped exactly like the `@deepseek-ai/dsh-token-meter/client$` entry beside it. Exercising the gate's own `resolveId` accepts that specifier and still rejects `@deepseek-ai/dsh-cordis-host-runner`, `/types`, `/wire-values/nested`, and `/wire-values-extra`. Building `cordis-client-runner`'s browser bundle confirms the effect: the schema text and `errorDetails` are inlined, and `@deepseek-ai/cordis` remains the bundle's only `@deepseek-ai` require.

**The guard twin: dispatch is shared, the traps stay two.** The file's original prose said folding was not available because the halves compile in separate programs whose `Context` merges different service keys. That is not what blocks anything: a factory generic in the context object type indexes `ctx[prop as keyof C]` and compiles on both sides. Separating mechanism from policy inside the matched region gives the right answer. The core of it — "forward a Context verb, refusing a timer mixin the plugin did not declare" — is one rule with a name and no per-half content: `CTX_VERBS` and `TIMER_VERBS` hold the same members on both sides, and the lookup-and-apply is identical. That is now `ctxVerbForwarder`, called by both guards. Nothing moved out of the operation that enforces it: `denyRead` is passed in, so each half still decides what it refuses and what the refusal teaches.

What stays written twice is the traps around it, and each of their decisions belongs to one half: the `tools` seat only the Host offers, what `get` hands back, the two `denyRead` bodies with their different teaching text, the read-only wording in `set`, and the `has` reachability line that starts from a different façade API on each side. Those are policy, and the guard that enforces a denial is where the denial is decided. After the extraction none of it matches: the longest identical token run across the two traps is 47 tokens, under the 60-token floor, so `bun run duplication` reports no clone in `packages/extensions` at all.

**Consequences.** `bun run duplication` finds zero clones under `packages/extensions`. `scripts/client-bundle-purity.spec.ts` pins the new entry with the same accept-and-reject pair the `token-meter/client$` precedent carries.
