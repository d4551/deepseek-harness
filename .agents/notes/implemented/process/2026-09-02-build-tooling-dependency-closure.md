# Agent Note: The build's own tooling stays closed over published dependencies

Status: implemented

English | [中文](2026-09-02-build-tooling-dependency-closure.zh.md)

## Problem

`tsdown.config.ts` imports `typertPlugin` from `packages/typert/generator/lib/types/tsdown-plugin.js`, and Node resolves that module's whole import graph while tsdown loads its config — before the build it configures has written anything. Every dsh package resolves to `lib/index.js`, the bundle that same tsdown run produces. When `packages/typert/generator/src/ts7-session.ts` started importing `@deepseek-ai/dsh-diagnostic-text`, the config began resolving a specifier that only exists after the build it gates, and `bun run build` stopped with `Cannot find module .../dsh-diagnostic-text/lib/index.js`. A working tree still holding bundles from an earlier build kept building, so the break reached master looking like a stale tree rather than an ordering cycle, and was worked around by hand-copying the tsc emit to `lib/index.js`.

## Decision

The Typert generator resolves only npm dependencies and its own emit. `flattenDiagnosticMessageText` lives in `packages/typert/generator/src/ts7-session.ts`; `ts7-project.ts` and `tests/type-model-shared.ts` import it from there, and the manifest declares no workspace runtime dependency. `packages/util/diagnostic-text` keeps `flattenDiagnosticMessage` for `scripts/ts7-session.ts`, which tsx resolves through `paths` to source and which no build config loads.

`checkBuildToolingClosure` in [scripts/check-workspace-constraints.ts](../../../../scripts/check-workspace-constraints.ts) holds the rule: it reads the root `tsdown.config.ts`, treats every workspace package the config imports a file from as build tooling, and rejects a `dependencies` or `optionalDependencies` entry naming another workspace member. `peerDependencies` stay legal — a dsh package declares Cordis and the invariant service for its companion plugin, which a build config never loads. The check runs in the `constraints` gate, so `bun run hygiene` and CI reject the manifest edit that caused this before anyone reaches a clean tree.

## Alternatives considered

**A bootstrap tsdown pass before the plugin-bearing one.** A first pass with no plugins would produce the tooling's workspace bundles, keeping one implementation of the flattening. It puts a second tsdown invocation and a second config in every build, and that config's package list has to track the tooling's dependency graph or fail exactly the way this did. That cost lands on every build to share four lines.

**Point `@deepseek-ai/dsh-diagnostic-text` at its tsc emit.** Setting `main` and `exports["."].default` to `lib/types/index.js` needs no bundle and resolves after `tsc -b`. It gives one package an entry layout no other dsh package has, and the `constraints` rules that hold every published package at `lib/index.js` would need a per-package exception.

**Load the config through tsx and import the plugin from `src`.** `--config-loader tsx` with `paths` resolution reaches source for everything. It resolves the generator from the source plane while the build it configures consumes the artifact plane, and puts a TypeScript transform in front of every build.

**Delete `packages/util/diagnostic-text` and return the copy to `scripts/ts7-session.ts`.** That removes the published package, its bilingual README, its tests, and its catalog entry to reach the same two copies of the function this decision leaves in place.

## Consequences

`bun run build` succeeds on a tree with no prior bundles, verified from the failing state: the run that proves it deleted `packages/util/diagnostic-text/lib/index.js` first and finished by writing it as a real bundle.

The flattening exists twice — `flattenDiagnosticMessageText` in the generator and `flattenDiagnosticMessage` in `dsh-diagnostic-text`. The two differ in name and in the type they accept, so `bun run duplication` does not see them, and the gate plus the comment at the generator's copy are what keep the next reader from replacing it with the import again. Any future workspace dependency for build tooling has to arrive with the bootstrap pass that makes it resolvable, not as a manifest line.
