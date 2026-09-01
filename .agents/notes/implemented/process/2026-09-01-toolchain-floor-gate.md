# Agent Note: A toolchain floor gate for the version pins CI runs on

Status: implemented

English | [中文](2026-09-01-toolchain-floor-gate.zh.md)

## Problem

The version-drift audit found the only real downgrade protections were `bun.lock` (regenerable) and CI matrix legs: `checkSingleExternalVersion` enforces one base version per dependency across manifests but says nothing about *which* version, and no test pinned the engines string, the packageManager value, or any toolchain floor. A coordinated downgrade — `typescript@^6`, `vite@^7`, `react@~18` — passed every existing gate.

## Decision

`scripts/verify-toolchain-floors.ts` (+ spec) asserts the toolchain pins against floors:

- `engines.node` must equal `^22.19.0 || >=24.0.0` verbatim, and `packageManager` must equal `bun@1.4.0` exactly.
- Toolchain dependencies must sit at or above `(major, minor)` floors, checked across the root manifest and `apps/web/package.json` (the browser toolchain — react, playwright — is pinned at the web entry, not the root): typescript `7.0`, vite `8.2`, react/react-dom `19.2`, playwright `1.62`, vitest `4.1`, tsx `4.23`.
- A toolchain name absent from every manifest is itself a finding — removing the dependency everywhere is a silent downgrade of what CI runs.
- `rangeMeetsFloor` reads the base of the range (`^`, `~`, `>=`, or bare): any base below the floor on major or minor fails; a base on a higher major passes, because an untested newer toolchain is not a floor miss and is caught by the lanes that exercise it.

Registered as the `toolchain-floors` leaf in `ciSharedStaticGates` (`scripts/run-gates.ts`), so it runs in `ci-primary`, `ci-static`, and every aggregate that shares those gates. Package script: `bun run verify-toolchain-floors`.

## Alternatives considered

**Rely on Renovate/lockfile drift detection alone.** Those tools update; they do not forbid. A human merging a deliberate downgrade still needs a gate that names the floor, and the lockfile is regenerable in the same PR as the downgrade.

**Pin exact versions in the root manifest.** Caret ranges are intentional — patch and minor movement is trusted. The floors keep the range syntax while failing the base that drops below the tested toolchain.

**Check only the root manifest.** The browser toolchain (react, playwright) is pinned at `apps/web`, not the root; a root-only scan would miss exactly the lanes a downgrade would break.

## Consequences

A coordinated downgrade of any of the seven toolchains, the engines string, or the bun pin now fails `ci-static`. The gate costs a maintenance edit whenever a floor is deliberately raised — and that edit is the reviewable act of saying which toolchain version CI now assumes. The first live run surfaced the build-order cycle the [build-tooling dependency closure](2026-09-02-build-tooling-dependency-closure.md) note owns: the root tsdown config could not resolve `packages/util/diagnostic-text/lib/index.js`, the bundle that same build writes.
