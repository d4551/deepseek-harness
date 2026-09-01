# Agent Note: The build bundles the tooling its own config loads

Status: implemented

English | [中文](2026-09-02-build-tooling-dependency-closure.zh.md)

## Problem

`tsdown.config.ts` imports the Typert plugin from `packages/typert/generator/lib/types/tsdown-plugin.js`, and Node resolves that module's whole import graph while tsdown loads the config — before the build it configures has written anything. Every dsh package resolves to `lib/index.js`, the bundle that same tsdown run produces. So when the generator started importing `@deepseek-ai/dsh-diagnostic-text`, the config began resolving a specifier that exists only after the build it gates, and `bun run build` stopped with `Cannot find module .../dsh-diagnostic-text/lib/index.js`. A working tree still holding bundles from an earlier build kept building, so the break reached master looking like a stale tree; it was first worked around by hand-copying the tsc emit to `lib/index.js`, and then reproduced on a second machine from a clean checkout.

## Decision

`build:lib:host` runs a bootstrap tsdown pass between `tsc -b` and the plugin-bearing Host pass, so the packages the Host config resolves already carry their bundles when it loads:

```sh
tsc -b tsconfig.host.json
tsdown --config tsdown.bootstrap.config.ts
tsdown --env.DSH_BUILD_FACE host
```

`tsdown.bootstrap.config.ts` loads no plugin of its own. Its package set is derived, not listed: [`scripts/build-tooling-closure.ts`](../../../../scripts/build-tooling-closure.ts) reads the Host config, takes every workspace package it imports a file from, and walks those manifests' `workspace:` runtime dependencies transitively through the installed links. The tooling packages themselves are included so the set is never empty while the config imports one, and a config that imports no workspace package at all fails loud telling the maintainer to drop the pass. Both passes bundle under `WORKSPACE_BUNDLE_OPTIONS` from [`scripts/tsdown-workspace-options.ts`](../../../../scripts/tsdown-workspace-options.ts), so a package's output does not depend on which pass wrote it.

`checkBuildToolingBootstrap` in [`scripts/check-workspace-constraints.ts`](../../../../scripts/check-workspace-constraints.ts) holds the ordering: the `constraints` gate rejects a `build:lib:host` that omits either pass or runs the bootstrap second. The generator keeps its import of the shared `@deepseek-ai/dsh-diagnostic-text`, which is what this arrangement exists to allow.

## Alternatives considered

**Forbid workspace runtime dependencies in build tooling.** A manifest rule rejecting `dependencies` on any package the config imports keeps the build a single pass and needs no new config. It also re-duplicates the flattening the shared package had just absorbed, and makes a whole class of legitimate sharing illegal to protect one ordering rule. The bootstrap pass costs about 0.4 s and removes the rule instead.

**Load the config from source with a TypeScript-aware loader.** `--config-loader tsx` pointed at `packages/typert/generator/src/tsdown-plugin.ts` would end the artifact dependency outright, which is how comparable bundler configs resolve their plugins. It does not run here: tsdown's tsx loader fails on Node 26 with `ENOENT ... node:fs?tsx-namespace=<uuid>` through its CJS hook, `unrun` is not installed, and the default native loader rejects the generator's parameter properties in strip-only mode. Worth revisiting when a loader works across the whole engines range, at which point this pass can go.

**Publish the tooling's dependencies and consume them by version.** A published `dsh-diagnostic-text` resolved from the registry never depends on this build. The repository is pre-release and its packages move together, so this trades a build ordering problem for a release ordering problem.

**Point `@deepseek-ai/dsh-diagnostic-text` at its tsc emit.** Setting `main` and `exports["."].default` to `lib/types/index.js` needs no bundle and resolves after `tsc -b`. It gives one package an entry layout no other dsh package has, and the `constraints` rules holding every published package at `lib/index.js` would need a per-package exception.

**List the bootstrap packages by hand.** A literal array in the bootstrap config is shorter than the derivation. It also drifts silently the first time build tooling gains a dependency, which is exactly the failure being fixed.

## Consequences

`bun run build` succeeds on a tree with no prior output, verified from the failing state: the run that proves it deleted `packages/util/diagnostic-text/lib/index.js` first, bundled it in the bootstrap pass, and rebuilt it in the Host pass. Build tooling may now take workspace dependencies, and adding one needs no edit to the bootstrap config.

The build carries a second tsdown invocation and a config whose package set is computed while it loads. A declared workspace dependency that is not installed now fails at that computation, naming the package, rather than inside the Host pass. The gate checks the script's ordering only: another tool that loads `tsdown.config.ts` outside `build:lib:host` would need its own bootstrap, and nothing checks that today.
