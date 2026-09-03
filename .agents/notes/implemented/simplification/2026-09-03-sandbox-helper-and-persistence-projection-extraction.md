# Agent Note: Three clones extracted into the Service Definitions that already owned their vocabulary

Status: implemented

English | [中文](2026-09-03-sandbox-helper-and-persistence-projection-extraction.zh.md)

## Problem

Removing `.jscpd.json`'s in-file suppression ([the marker note](2026-09-03-duplication-suppression-that-suppressed-nothing.md)) surfaced three clones that a marker had been hiding, each of which had grown a comment arguing for its own duplication.

`bash-sandbox/src/helpers.ts` and `pwsh-sandbox/src/helpers.ts` were the same 110 lines — 515 tokens, the largest clone in the repository. Only the module header differed, and the pwsh copy's header said so: "deliberate call-for-call mirror of `@deepseek-ai/dsh-bash-sandbox/src/helpers.ts`". The [pwsh tool and executor note](../feature/2026-08-01-pwsh-tool-and-executor.md) does justify parallel *tool* surfaces, because a model sees two tools. It says nothing about internal classification logic, which no model or user observes and which had no platform-dependent line in it: every rule is parameterized by the denial signatures and `RunnerFailureRule`s the selected runner publishes, so bwrap, Landlock, Seatbelt, and the Windows ACL runner already flow through one code path.

`session-persistence-jsonl` and `session-persistence-sqlite` each spelled out the same eight forwards to `PersistenceCoordinator` — 33 lines. The JSONL copy carried the standing argument: "extracting these trivial forwards would add an inheritance layer." Both providers already extend `SessionPersistence`; the layer existed and only its middle was missing.

`inspector/.../runtime/frames.ts` repeated one envelope-and-address parse twice within a single file, under a comment claiming that "each wire parser spells out its own envelope literally instead of sharing a tag-parameterized helper." Nothing enforced that; the two parsers differed by one string.

## Decision

Each extraction goes to the Service Definition that already owns the vocabulary, published as a named subpath so a Consumer imports the owning module and never a sibling provider.

`@deepseek-ai/dsh-shell/sandbox-classify` owns `isRunnerSpawnFailure`, `classifyDenial`, `classifyRunnerFailure`, and `matchesSignature`. The shell seam is the only candidate that can name both halves: it declares `ShellRunResult` and the `ShellSandboxInfo` facts these functions produce, and it already peer-depends on `@deepseek-ai/dsh-sandbox` for `RunnerFailureRule`. The sandbox seam cannot host them without acquiring a dependency on the shell seam. Both provider packages already depended on `@deepseek-ai/dsh-shell`, so no new edge crosses the graph. Neither provider retains a divergent line: the whole 110 lines were common.

`@deepseek-ai/dsh-session-persistence/coordinated` owns `CoordinatedSessionPersistence<TornMarker>`, an abstract class between `SessionPersistence` and the two backends that implements the eight coordinator forwards and declares `protected abstract readonly coordinator`. Each backend keeps only what its storage medium decides: `locate`, `list`, `listSnapshots`, and its `PersistenceBackend` hooks.

Inside `frames.ts`, `assertFrameEnvelope` and `parseFrameAddress` are the two operations every frame parser performs, and `parseRequestAddressedFrame` composes them for the two frames that carry nothing but a request id. Error text is unchanged: the per-frame label already supplied the only varying word, so `invalid ${label} envelope` reproduces each message verbatim.

## Alternatives considered

**A `packages/util/*` home for the classification helpers.** They are pure, but `classifyRunnerFailure` is typed by `RunnerFailureRule` and `classifyDenial` by `ShellRunResult`. A zero-dependency package would have to restate both, replacing one clone with two type clones.

**Re-export the new modules from each package's `index.ts`.** `no-barrels` permits it for a published entry, and `render.ts` is precedent. A subpath was chosen instead so the import names the owner directly, and so neither Service Definition's documented root surface — which the generated Cordis catalogs project — moves for a refactor that adds no capability.

**Keep the persistence forwards and accept the clone.** This is what the in-file comment argued. The cost it named, one inheritance layer, is one abstract class in the package that already declares the abstract service; the cost it did not name is that eight operations drift independently in two providers of the same seam.

## Consequences

`bun run duplication` reports none of the three. `packages/shell/shell` and `packages/session/session-persistence` each gained a package-local `tsdown.config.ts`, because the default workspace entry list bundles only `index` and `invariant` and a packed install would otherwise resolve the new subpath to a missing file. `bash-sandbox` and `pwsh-sandbox` no longer carry `src/helpers.ts`; their existing pure-helper suites now exercise the shared module and together cover every branch of it.
