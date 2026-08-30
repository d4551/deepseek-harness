# Agent Note: Compile with TypeScript 7; every compiler-API import is TS7-native

Status: implemented

English | [中文](2026-08-29-typescript-7-compiler.zh.md)

## Problem

TypeScript 7.0 ships the Go-based `tsc`. The `typescript` package's default export is version metadata (`lib/version.cjs`), not the 6.0 Strada compiler API (`createProgram`, `createSourceFile`, `ts.sys`). Microsoft documents a *stable* replacement in 7.1. This repository compiles through `tsc` and also walks programs and source files in Typert and the gate scripts.

## Decision

Compile Host and Client programs with TypeScript 7.0.2 (`typescript` ^7.0.2). That package already exports the new compiler API under `typescript/unstable/sync` (Snapshot / Project / Program / Checker) and `typescript/unstable/ast` (`SyntaxKind`, visitor, factory). `scripts/typescript7-unstable-api.spec.ts` loads those exports from the mandated pin and parses `tsconfig.host.json` through `API.parseConfigFile`.

Every compiler-API consumer — Typert, the gate scripts, and the Stryker tsconfig patch (which parses JSONC through `jsonc-parser`) — uses `typescript/unstable/*`; the `@typescript/typescript6` compatibility package is absent from the dependency graph, and `scripts/typescript7-unstable-api.spec.ts` fails if any manifest or source imports it again. The rewrite off the 6.0 API was not an import rename: the 6.0 `createProgram` surface is not on `import 'typescript'`, so isolated parses, configured projects, and printing moved to `API`/`Project`/`Emitter` sessions owned by `ts7-session.ts`.

TypeScript 7 rejects two patterns 6.0 accepted. A name cannot carry an imported type meaning and a locally declared value meaning; `cordis-host-runner` keeps the factories next to their type aliases in `types.ts`. `@ts-expect-error` must sit on the line TypeScript 7 reports, not the line before a multi-line call.

The root README names this compile pin as part of this checkout's toolchain. Contributor setup is in the [development guide](../../../../docs/development.md). The package manager pin is a separate decision in [the bun package-manager Agent Note](2026-08-29-bun-package-manager.md).

## Alternatives considered

**Stay on TypeScript 6.0.3 for compile and API.** Rejected: the Go `tsc` is the compile pin this checkout takes, and the compatibility package exists for the API window.

**Import the default `typescript` 7 export for `createProgram`.** Rejected: that export is version metadata. The 6.0 Strada methods are not there.

**Keep `@typescript/typescript6` as the finished TypeScript 7 conversion.** Rejected: that package is TypeScript 6.0. TypeScript 7 is the compile mandate; remaining Strada imports are unfinished conversion onto `typescript/unstable/*`.

**Wait for a stable TypeScript 7.1 API tag before any 7 API use.** Rejected for the existence check: 7.0.2 already ships `typescript/unstable/*`. A later 7.1 stable tag can drop the `unstable/` path without changing the compile pin.

## Consequences

`bun run typecheck` and `bun run build` run the Go `tsc`, and the whole repository compiles and analyzes through the TypeScript 7 API with no TypeScript 6 package installed. `eslint-plugin-sonarjs` is removed from the lint toolchain: it reads the 6.0 compiler API at module load (`cjs/helpers/type.js`) and hard-requires `typescript <6.1`, so it cannot load under the TS7-only graph. Its identical-conditions and duplicate-composite coverage is kept through native Oxlint rules (`no-dupe-else-if`, `typescript/no-duplicate-type-constituents`); the remaining duplicate-shape rules rely on the jscpd `bun run duplication` gate until Oxlint ports them natively.
