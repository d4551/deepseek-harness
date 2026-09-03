# Agent Note: Seam-provider plumbing had owners, not reasons

Status: implemented

English | [中文](2026-09-03-seam-provider-plumbing-duplication.zh.md)

## Problem

Four package pairs carried 12 clones that [the suppression note](2026-09-03-duplication-suppression-that-suppressed-nothing.md) unhid, and every one of them was annotated with prose explaining why the repetition was intentional:

| Clones | Lines | Pair | The claim at the site |
|---|---|---|---|
| 4 | 74 | `credentials-local` ↔ `settings-file` | "same watcher discipline as settings-file by design"; "deliberately mirrored … extracting a shared helper would couple their teardown semantics across packages" |
| 4 | 45 | `subagent-claude-code` ↔ `subagent-codex` | "sibling product providers intentionally expose overlapping deployment-owned fields without adding a shared config owner"; "sibling providers intentionally keep product-private run inputs and error normalization" |
| 2 | 38 | `code-runtime-worker-thread` ↔ itself | "the source worker mirrors session JSON helpers without workspace runtime imports" |
| 2 | 23 | `time-context` ↔ `llm-retry` | "domain-specific delay validation parallels llm retry-policy; not extractable" |

Only one of those claims survived contact with the code, and not the one it was written about.

## What the claims turned out to be

**"Coupling their teardown semantics across packages" was an excuse.** The credentials and settings providers store different documents with different parse rules, different permission checks, and different publication events — and identical *plumbing*: the same Schemastery config fields, the same chokidar options derived from `debounceMs`, the same `all`/`ready`/`error` handlers, the same one-settled-tail operation chain, the same `INVARIANT`-propagates-else-warn reload policy, the same ENOENT-is-absence read, and the same quiesce-at-dispose. The teardown semantics were not two contracts that risked coupling; they were one contract written twice.

**"Not extractable" was wrong about its own subject.** The `time-context` ↔ `llm-retry` clone is not delay validation at all — it is the invariant-companion plumbing that the [session staging note](2026-09-03-session-staging-plumbing-owner.md) gave an owner earlier the same day. Both companions hand-rolled the `ctx.sessions.list()` seed, the `session/created` listener, and the `internal/dispatch` interception that `stageSessionEvents` already installs for six other packages. The two files were laggards, not exceptions.

**"Without workspace runtime imports" was true, and irrelevant to the duplication.** `worker-json.ts` and `output-json.ts` really must not import a workspace package: `source-worker.compat.spec.ts` copies the worker's file set out of the workspace and boots it, so any package import fails there. That constraint forbids importing `@deepseek-ai/dsh-session`'s JSON helpers. It says nothing about the two files importing each other, which they now do.

**"Product-private run inputs and error normalization" was half true.** The two run specs describe different products, but `thrown()` was a fourth copy of a function `@deepseek-ai/dsh-subagent` already had, and the four config-derived fields of both specs are one record.

## Decision

### `@deepseek-ai/dsh-document-queue` owns one document's operation chain

The two providers implement different seams (`ctx.credentials`, `ctx.settings`), so neither may import the other and neither Service Definition can hold the shared code. It went to a new `packages/util/` package that both now depend on: `DocumentQueue` (the settled-tail chain, `watch()`, `close()`, `isClosed()`, and the reload policy), `resolveDocumentSpec` (the one defaulting step for `path`/`dshHome`/`watch`/`debounceMs`), `readDocumentText`, and `isENOENT`. `credentials-local` fell from 954 lines to 857 and `settings-file` from 370 to 292, while the queue that replaced those 175 lines is 245 including its documentation.

Behavior is unchanged and the split is deliberate: the queue never opens the document for content, so permission checks, format detection, parsing, comment-preserving rendering, the `dsh-atomic-write` writer lock, and seam publication all stayed with their providers. `settings-file`'s `ResolvedSpec` now extends the shared `DocumentSpec` with its format field.

`lock-race.spec.ts` reached into the provider's private `closed` field to observe that teardown refuses new work before an in-flight create settles. It now reads `queue.isClosed()`, which is where that flag lives.

### `@deepseek-ai/dsh-subagent` owns one-shot provider config resolution

Both providers already depend on the seam, and `src/out-of-process.ts` already existed for exactly this: provider-side vocabulary for out-of-process backends. It gained `resolveOneShotProviderConfig` with `OneShotRunConfig`/`OneShotProviderConfig`/`OneShotProviderDefaults`, `assertTimerBound` (the positive-finite check plus the `MAX_TIMER_DELAY_MS` ceiling both providers spelled out, with both diagnostics preserved verbatim), and the previously module-private `toError`. `ClaudeCodeRunSpec` and `CodexRunSpec` now extend `OneShotRunConfig<TMode>` and add only `cwd`, `spawn`, and `onError`, so each `start()` builds its spec as `{ ...this.config, cwd, spawn, onError }` instead of copying four fields by hand.

`env` and `disposeGraceMs` keep their `as` casts rather than gaining `??` defaults: a programmatic caller that omits `disposeGraceMs` must still fail loud in `assertTimerBound`, and inventing a default there would both change that behavior and leave an uncoverable branch under the per-file 100% gate.

The seam gained `@deepseek-ai/dsh-timeout` (peer + dev + project reference) for `MAX_TIMER_DELAY_MS`. It did not gain `@deepseek-ai/dsh-subprocess`: the run specs' `spawn` field keeps its `SubprocessSpawnSpec`/`SubprocessHandle` types in each provider package, so the seam still states no process machinery. `subagent-acp` and `subagent-dsh-sdk` still hand-roll their own `assertPositiveFinite` and timer ceiling; they were out of this change's scope and are the next callers for `assertTimerBound`.

### The worker closure gets a fifth member

`src/intrinsics.ts` holds `IntrinsicCallable`, `intrinsicReflectApply`, `dataDescriptor`, `defineEnumerableDataProperty`, `append`, and `takeLast` — the prototype-safe primitives both JSON modules built values through. It imports nothing, so the copied-out source closure still boots; `source-worker.compat.spec.ts` copies it with the other four files, which is the test that proves the constraint the old comment named.

### `time-context` and `llm-retry` adopt `stageSessionEvents`

Both companions now install through `@deepseek-ai/dsh-session/invariant-staging`. Their state is the session itself, because each check reads the committed prefix — `time-context` needs the open turn and step plus the current turn's entered messages, `llm-retry` needs the open step, the routed provider, and the earlier records of the same chain — and at `internal/dispatch` the session holds exactly the events that precede the candidate. `seed` runs the existing whole-session validation, `stage` runs the existing per-event validation, `claims` names the package's own event types, and `commit` returns the state unchanged. No validation rule and no failure message changed; the companions gained the shared owner's guarantee that a claimed event published without passing dispatch fails instead of committing silently.

This also removed a third clone the pair shared with `goal-round-driver`.

## How the config-catalog walker admits a shared field set

[`scripts/gen-config-catalog.ts`](../../../../scripts/gen-config-catalog.ts) walks each plugin entry's schema statically and follows a `z.object(...)` argument exactly one named hop: an identifier the entry file itself declares, or one the entry file of a workspace package it imports declares. A spread stays out of reach — `z.object({ ...documentQueueConfigFields() })` reports `@deepseek-ai/dsh-credentials-local (packages/credentials/credentials-local/src/index.ts): schema object property '...documentQueueConfigFields()' is not a plain key`, after which the catalog would state no accepted fields for that plugin — but a named exported object is not.

Both pairs validate through that hop:

- `credentials-local` and `settings-file` write `static Config: z<Config> = z.object(DocumentQueueConfigFields)`. `@deepseek-ai/dsh-document-queue` declares those four validators beside `resolveDocumentSpec`, so the Loader schema and the defaulting step read one `DEFAULT_WATCH` and one `DEFAULT_DEBOUNCE_MS`.
- `subagent-claude-code` and `subagent-codex` write `z.intersect([z.object(OneShotProviderConfigFields), z.object({ … })])`, which the walker follows through both members. `@deepseek-ai/dsh-subagent` owns `model` and `env`; `providerName`, `permissionMode`, and `disposeGraceMs` stay in each provider's own half, because each names that product's own default or mode vocabulary.

`OneShotProviderConfigFields` is declared in `@deepseek-ai/dsh-subagent`'s `src/index.ts` rather than beside `OneShotProviderConfig` in `src/out-of-process.ts`: the hop lands on the owning package's entry file and does not follow a re-export from it, so a declaration one module deeper leaves the plugin's accepted keys uncatalogued.

The interface declarations stay local: the catalog pastes each plugin's `Config` verbatim as its deployment surface, and each paste documents a different default document path or a different product's permission modes. Renaming a shared field so it no longer exists on a plugin's declared `Config` fails the generator with `schema validates key '<name>' but config type 'Config' declares no such member`, which is the check that keeps the hop honest.

## Consequences

- One module owns the document chain, so a change to watcher settling, reload policy, or drain ordering happens once and both file-backed providers inherit it. Neither provider imports the other, and the two seams stay independent.
- `credentials-local` and `settings-file` no longer depend on `@deepseek-ai/dsh-home-paths`; `settings-file` no longer depends on `chokidar` at runtime (its watcher-fake suite keeps it as a devDependency, as does `credentials-local`).
- `@deepseek-ai/dsh-subagent` now depends on `@deepseek-ai/dsh-timeout`. Every package that peers on the subagent seam gains that edge; `dsh-timeout` is a leaf utility with no dsh dependencies of its own.
- `dsh-document-queue` is a new published release member with `exports`, `files`, an `./invariant` companion, and a bilingual README. It has no `tsdown.config.ts`: its two entries are `index` and `invariant`, which the default workspace entry list already bundles.
- `time-context` and `llm-retry` now fail loudly if one of their own events reaches publication without passing dispatch, which is the shared staging owner's contract rather than new package-specific behavior.
- `@deepseek-ai/dsh-document-queue` and `@deepseek-ai/dsh-subagent` own the Loader field validators their providers share, so a field added to either set reaches both plugins at once. `dsh-document-queue` gained `@deepseek-ai/schemastery` (dependency + project reference) to publish them.
- `subagent-acp` and `subagent-dsh-sdk` still carry their own positive-finite-plus-ceiling checks. They now have `assertTimerBound` to adopt.

## Alternatives considered

**Put the document plumbing in `@deepseek-ai/dsh-atomic-write`.** Both providers already depend on it and it already owns the cross-process half of writer coordination. Rejected because it would put `chokidar` in the dependency closure of `attachment-local`, `app-boot`, `llm-deepseek`, `agent-presets`, `session-persistence-jsonl`, and `storage-json`, none of which watch anything.

**Put the invariant plumbing in `@deepseek-ai/dsh-invariants`.** Rejected twice over: [the invariant-service note](../architecture/2026-07-19-package-invariant-runtime-contracts.md) states that the registry imports no product package, and `dsh-session` already depends on the registry, so the import would be a cycle in the project references. `dsh-session` owning it — which is what `invariant-staging` does — has neither problem.

**Convert `llm-retry` and `time-context` to incremental cursors instead of holding the session.** Rejected as out of scope. Both validators are written against a history slice, and re-deriving their relations as folds would change what the invariants observe, which belongs to whoever owns those contracts rather than to a duplication pass.

## JSON structural equality has a platform owner

`credentials-local` compares two parsed credential records with `node:util`'s `isDeepStrictEqual`. Every record passes `assertJsonValue` before reaching the comparison, so the platform predicate and the hand-rolled walk it replaces agree on every admitted value, and the platform one additionally distinguishes prototypes and symbol keys the walk ignored.

`experimental/webworker-runtime`'s implemented `util` built-in keeps its own structural walk, because that module *is* `node:util` inside the worker: [`src/module-proxies.ts`](../../../../packages/experimental/webworker-runtime/src/module-proxies.ts) resolves `node:util` onto it, and `context/agent-instructions`, `mcp/mcp-client`, and `goal/goal-round-driver` reach `isDeepStrictEqual` through that specifier. Nothing bans a workspace import there — `builtin_modules/implemented/crypto.ts` sources `randomUUID` from `@deepseek-ai/dsh-util-crypto` and the worker bundle inlines every dependency — so the constraint on that tree is browser-safety and bundle weight; what keeps the walk local is that a Node API's own implementation may not be sourced from the harness code that calls it.

`@deepseek-ai/dsh-settings`' exported `deepEqualJson` and `core/session/src/surface.ts`'s `isDeepEqualJson` are a second and third spelling of the same rule. Neither is a jscpd clone of the other or of the worker's, and the settings one is a Service Definition's published change-detection predicate that its invariant companion checks directly; folding those two is a seam decision rather than a duplication pass.

## Evidence

`bun run duplication` reports one clone across `packages` and `scripts`: a self-clone inside `client/ui-slots/src/index.ts` that nothing here touches. All 12 clones in this note's scope are gone, the last three of them through the shared field sets and the platform predicate above.

`bun run gen-config-catalog` accepts both field-set hops, and its output changes only in four `Source:` line numbers — `credentials-local:65`, `subagent/subagent:190`, `subagent-claude-code:38`, `subagent-codex:38` — which name where each declaration now sits. Every pasted config declaration is byte-identical and no plugin section lost a field. Renaming `debounceMs` inside `DocumentQueueConfigFields`, or `env` inside `OneShotProviderConfigFields`, fails the generator for both dependent plugins with `schema validates key '<name>' but config type 'Config' declares no such member`, which is the acceptance path that proves the walker crosses the package hop.

Scoped `bun x vitest run` passes for `util/document-queue` (15), `settings/settings-file` (48), `credentials/credentials-local` (104 + 2 skipped), `code-runtime/code-runtime-worker-thread` (104), `context/time-context` (51), `llm/llm-retry` (66), and all of `packages/subagent` (1052 passing). `subagent-codex/tests/real-product.spec.ts` fails the same 3 assertions before and after, on a fixture/product-version drift under separate investigation. Coverage over every touched file meets all four per-file thresholds at 100%. `bun x tsc -b`, `no-barrels`, `verify-export-jsdoc`, `run-oxlint`, `verify-package-invariants`, `check-workspace-constraints`, `verify-module-graph`, and `verify-doc-budgets` all pass.
