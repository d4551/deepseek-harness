# Agent Note: Live-stack and toolchain floors share one latest-stable triple

Status: implemented

English | [中文](2026-09-06-live-stack-toolchain-floor-agreement.zh.md)

## Problem

Two floor collectors named the same toolchain and could disagree without failing. [`scripts/live-stack-floors.ts`](../../../../scripts/live-stack-floors.ts) held vitest and `@vitest/coverage-v8` at 4.1.11 while the root manifest and [`scripts/verify-toolchain-floors.ts`](../../../../scripts/verify-toolchain-floors.ts) already required vitest 5. A tree that shipped `^5.0.0` passed both collectors, so the stale live-stack number was invisible. The live-stack collector also never read `packageManager`, so bun 1.3.x would not fail that spec.

## Decision

[`LIVE_TOOLCHAIN_FLOORS`](../../../../scripts/live-stack-floors.ts) is the SemVer source for the names both collectors share (TypeScript, Vite, React, react-dom, Playwright, vitest, tsx). `TOOLCHAIN_FLOORS` is the (major, minor) projection of that map; it does not restate the numbers. `@vitest/coverage-v8` uses `VITEST_FLOOR` rather than a second triple. `BUN_PIN` is `bun@1.4.2` and both collectors compare the root `packageManager` field to that exact spelling.

[`collectorFloorDisagreements`](../../../../scripts/live-stack-floors.ts) fails an injected pair where one collector would accept a pin the other rejects (vitest 4.1.11 vs [5, 0]). Live specs read the root and `apps/web` manifests and the installed `vitest` / `@vitest/coverage-v8` package.json files, not a copied expected version string. Injected TypeScript 6, vitest 4, bun 1.3.x, bun 1.4.0, React 18, Vite 6, and forbidden Tailwind / daisyUI / htmx / `@apply` product UI still fail.

Product UI does not adopt daisyUI, Tailwind, or htmx; the floors reject them. TypeScript 7.1-dev, bun canaries, and axe canaries stay out of the pin.

## Alternatives considered

**Keep two independent floor maps and document the split.** Rejected: a documented split is how vitest 4.1.11 survived next to vitest 5. Agreement has to be a failing test, not a comment.

**Compare only major numbers.** Rejected: bun 1.3 vs 1.4 and Vite 8.1 vs 8.2 are the drifts these floors exist to catch.

**A `>=` bun pin (`bun@>=1.4.2`).** Rejected: CI installs the exact `packageManager` spelling through `bun-version-file: package.json`. A range would advertise runtimes the image has not been proven on.

## Consequences

Raising vitest, bun, TypeScript, React, or Vite means changing the SemVer triple in `live-stack-floors.ts` (and the root `packageManager` field for bun). A second copy that lags fails `collectorFloorDisagreements` or `packageManagerMisses`. The bun package-manager decision remains [the bun pin Agent Note](2026-08-29-bun-package-manager.md); this note owns the agreement between collectors.
