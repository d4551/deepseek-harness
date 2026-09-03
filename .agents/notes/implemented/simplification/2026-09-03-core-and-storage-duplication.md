# Agent Note: The core and storage codecs had one owner each, written twice

Status: implemented

English | [中文](2026-09-03-core-and-storage-duplication.zh.md)

## Problem

Fourteen clones across the session, tool, storage, and SQLite packages became visible when [the suppression note](2026-09-03-duplication-suppression-that-suppressed-nothing.md) removed the `jscpd:ignore` markers. Every site carried prose asserting that the repetition was deliberate:

| Clones | Lines | Pair | The claim at the site |
|---|---|---|---|
| 6 | 87 | `core/session` ↔ `session-persistence-sqlite` | "schema 19 deliberately owns a frozen physical codec; importing or sharing the JSONL codec would let that format mutate this database interpreter" |
| 2 | 31 | `core/session` ↔ `core/tools` | "this realm boundary mirrors the session-owned lossless-JSON intrinsic test" |
| 1 | 13 | `core/tools` ↔ itself | "the explicit-stack walk skeleton deliberately parallels ts-types.ts's renderSupportedSchema; the two sibling renderers keep symmetric shapes" |
| 1 | 23 | `storage-json` ↔ itself | "the two unit classes are standalone; the drain/guard lifecycle mirrors the shared KvUnit contract" |
| 1 | 9 | `subprocess-local` ↔ itself | "the Windows inspector deliberately mirrors process-inspector.ts: the decision logic is the same contract over Win32 primitives" |
| 1 | 16 | `session-query-sqlite` ↔ `storage-sqlite` | "the owner-only path setup below is byte-identical to the session-query-sqlite derived-index open, which this change does not touch" |
| 1 | 23 | `session-title-all-prompts-llm` ↔ `session-title-first-prompt-llm` | "Loader requires each plugin to export its own statically walkable schema; the field validators remain shared" |
| 1 | 10 | `llm/llm` ↔ `mcp-client` | "domain-specific delay validation parallels llm retry-policy; not extractable" |

## What the claims turned out to be

**"Schema 19 deliberately owns a frozen physical codec" described a real risk and the wrong remedy.** The two codecs do not merely resemble each other: they emit the *same bytes*. `classify`, `continues`, `buildRow`, `expandRow`, the run scan, and the whole envelope/member/gap validation were identical, and the sqlite `id` cast (`Extract<StreamChunk, { type: 'tool-call-delta' }>['id']`) resolves to the same `ToolCallId` the JSONL codec brands. A stored `text-chunks` row from either writer decodes correctly through the other. What schema 19 actually owns is three facts the JSONL log does not have — at most 1,024 members, at most 1 MiB of serialized data, and the binary-search run splitting that respects both — plus a `Buffer` byte measurement the Client face cannot run. Copying the encoding to protect those three facts left the frozen format defined in two places, which is the failure mode the comment feared, not the defence against it.

**"This realm boundary mirrors the session-owned lossless-JSON intrinsic test" was an excuse, and it named its own owner.** `hasIntrinsicConstructor`, `isIntrinsicObjectPrototype`, and `hasPlainArrayPrototype` were byte-identical in `core/session/src/json.ts` and `core/tools/src/json-schema.ts`, which already imports `@deepseek-ai/dsh-session` for `isJsonValue`.

**"The two sibling renderers keep symmetric shapes" was a description of copy-paste.** The TypeScript and Python SDK renderers differ in what they emit, not in how they walk: one explicit frame stack, one pending-child dispatch, one `finish` that pops and delivers to the parent, and the same two `v8 ignore` comments over the same two unreachable guards.

**"The two unit classes are standalone" was true of the layouts and false of the lifecycle.** `single` holds authoritative memory and republishes the whole file; `per-record` holds none and writes one document. Both had the same `closed` flag, the same in-flight write set, the same idempotent drain-then-release `close`, the same `assertOpen`, the same declared-global guard, and the same one-comment write tracker.

**"The Windows inspector deliberately mirrors process-inspector.ts" was true about the contract and false about the code.** The two tree walks differ in exactly one step: the POSIX table row carries its own start identity, while the Windows row resolves identity per pid and drops a member whose identity is unreadable. That is one parameter, not one copy.

**"Byte-identical to the session-query-sqlite derived-index open" was an accurate observation with no follow-through.** There were three copies of `createDatabaseFile`, not two — `session-persistence-sqlite/src/store.ts` had the third — and `@deepseek-ai/dsh-sqlite-connection` already existed as the owner of the open-time steps.

**"Not extractable" was wrong about its own subject.** The ten duplicated lines are neither MCP-specific nor LLM-specific: they bound one ordered pair of retry delays against Node's timer ceiling, using message text `@deepseek-ai/dsh-timeout` already produced from its private `assertTimerDelay`.

**"Loader requires each plugin to export its own statically walkable schema" was half right, and named the wrong enforcer.** The Cordis Loader accepts any Schemastery value. `scripts/gen-config-catalog-schema.ts` is what demands literals: `findInject` rejects an `inject` that is not an array literal, and `walkSchemaExpr` rejected `z.object(SessionTitleLlmConfigFields)` because the argument was an identifier rather than an object literal. The definition package already exported both the field validators and an unused `SessionTitleLlmConfigSchema`; the generator, not the Loader, is why each provider re-spelled the seven fields.

## Decision

### `@deepseek-ai/dsh-session/chunk-run-codec` owns the packed chunk-run encoding

The new module holds the row vocabulary (`ChunkRow`, `StorageRecord`, the two run-data payloads), the packing whitelist, run continuation, row construction, row expansion, the run scan, and `validateChunkRowShape` — everything a stored row means. It imports no Node built-in, so the Client face keeps decoding transported rows.

Each durable format keeps what is its own. `chunk-rows.ts` keeps `MIN_RUN = 3` and unbounded rows. `session-persistence-sqlite/src/codec.ts` keeps `MIN_PACKED_ROW_MEMBERS`, `MAX_PACKED_ROW_MEMBERS`, `MAX_PACKED_DATA_BYTES`, the `Buffer` byte measurement, the binary-search splitting, and `decodeSerializedChunkRow`. Both pass their own emitter to `scanChunkRuns` and their own validator to `decodeChunkStorageRecord`.

No stored byte changes. The encoder produces the same rows for the same events, and both decoders reject the same values; what changed is that a corrupt row's diagnostic text is now one vocabulary instead of two, since the checks that produced two spellings had one implementation. Schema 19 stays frozen in the sense that matters: the sqlite package still refuses another schema version, and a change to the shared encoding is a schema change for both formats — which is now visible in one file instead of requiring two edits to stay consistent.

### The session package owns the realm-intrinsic prototype tests

`hasPlainObjectPrototype` and `hasPlainArrayPrototype` are exported from `core/session/src/json.ts` through the package entry that already publishes `isJsonValue`. `core/tools/src/json-schema.ts` imports them and keeps its own `try/catch`, because a Proxy can throw from the prototype read and a JSON-Schema record that throws is simply not a plain record.

### Local owners for the three same-package clones

- `core/tools/src/schema-render-stack.ts` drives one post-order walk for both SDK renderers; each supplies `frame`, `start`, and `combine`, and the `v8 ignore` guards live once.
- `storage-json/src/unit-lifecycle.ts` is the abstract base both unit layouts extend for the closed guard, the write drain, the declared-global check, and the write tracker.
- `subprocess-local/src/process-tree-walk.ts` walks the table children-first and takes the identity step from its caller, which is the one thing the two platforms disagree about.

### `@deepseek-ai/dsh-sqlite-connection` owns the open-time path steps

`createDatabaseFile` and `prepareDatabasePath` join the connection settings there; all three SQLite packages call them. `session-persistence-sqlite` keeps its own `preparePath` because it validates the parent directory and the existing file between the directory creation and the file creation, so it calls `createDatabaseFile` after its own checks. `session-query-sqlite` gains the dependency it should already have had.

### `assertBackoffDelays` joins `@deepseek-ai/dsh-timeout`

It composes the module's existing `assertTimerDelay` twice and adds the ordering check, so `llm/retry-policy.ts` and `mcp-client/connection.ts` keep their exact messages while the bound lives with `MAX_TIMER_DELAY_MS`.

### The config catalog walks a field set another package owns

`walkSchemaExpr` now resolves a `z.object(...)` argument that names a `const` — declared in the same file, or exported by a workspace package the entry imports — to that object literal, and walks its properties in the owner's file. One hop, still fully static, still cross-checked against the plugin's declared config type. Both session-title providers now write `z.object(SessionTitleLlmConfigFields)`, and the orphan `SessionTitleLlmConfigSchema` is gone. `docs/config-catalog.md` is byte-identical before and after the generator change, and the two new fixture tests prove the walk both collects an owned field set and still rejects a key the config type omits.

`core/tools/src/invariant.ts` also moves onto `stageSessionEvents` and `advanceOpenTurn` from [the staging note](2026-09-03-session-staging-plumbing-owner.md), replacing its hand-rolled seed, `session/created` listener, publication fold, and open-turn map. Its dispatch-root and turn-enclosure relation is unchanged; a published code-dispatch record that skipped validation now fails instead of being validated a second time at publication.

## Alternatives considered

**Give the SQLite codec a `ChunkRowLimits` parameter and share the whole validator.** Rejected because the byte bound uses `Buffer.byteLength`, and `chunk-rows.ts` is imported by Client packages. Passing `Infinity` would still have run a `JSON.stringify` per decoded row on the JSONL path and pulled `Buffer` into a browser bundle.

**Put the realm-intrinsic predicates in a new `packages/util/*` package.** Rejected because a new package requires a reviewed bilingual README, and translation is not this change's work. `dsh-session` is already a `core/tools` dependency and the tools comment already named it as the owner.

**Merge the two session-title provider packages behind a config discriminator.** Rejected as an architecture decision outside a deduplication pass: the plugin names appear in shipped compositions, and the two providers are two registered seam identities.

**Leave the session-title schema duplicated because a gate demands literals.** Rejected once the gate turned out to be a repository generator rather than the Loader. A generator that forces seven field validators to be re-spelled per plugin is a generator limitation, and teaching it one static hop costs less than the copies it was imposing.

## Consequences

`@deepseek-ai/dsh-session` publishes `./chunk-run-codec`; `packages/core/session/package.json`, `tsconfig.base.json` (through `gen-tsconfig-paths`), and `scripts/gen-tsconfig-paths.spec.ts` record it. The generated alias region also picked up the subpaths other in-flight work had already declared in its manifests.

`docs/config-catalog.md` was already stale from concurrent work and is left untouched: the generator was run twice against the same tree, with and without the walk change, and produced identical output both times.

`packages/util/sqlite-connection` no longer states that file and directory creation belong to the backend; its README pair, its Known Limitations entry, and its package description now say what it actually does. Path *validation* — ownership and symlinked parents — still belongs to each backend.

Two clones remain against `core/session/src/json.ts`. `packages/extensions/cordis-host-runner/src/guard.ts` holds a third copy of the same intrinsic predicates under the same "mirrors the session-owned realm-safe intrinsic test" comment; jscpd reported the tools copy first and masked it. That package already imports `@deepseek-ai/dsh-session`, so the fix is the same import the tools package now uses, but it was outside this change's scope.

One measurement for whoever writes the next duplication note: under `.jscpd.json`'s `mode: "mild"`, jscpd 5 does **not** compare comment text. Two files whose only shared content is an identical JSDoc block do not clone, and a clone region reported across differing JSDoc — as the session-title pair was — is matching code on both sides of it. Prose at a duplication site is therefore never what trips the gate, and rewriting a comment never clears one.
