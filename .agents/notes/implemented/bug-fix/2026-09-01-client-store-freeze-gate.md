# Agent Note: A production fast path the client bundler made unreachable

Status: implemented

English | [中文](2026-09-01-client-store-freeze-gate.zh.md)

## Problem

`createSnapshotStore`'s wholesale `set()` bypasses immer's freeze, so `devFreeze` deep-froze the replacement value to stop a caller from mutating it afterwards and corrupting the store silently. It skipped that walk when `process.env.NODE_ENV === 'production'`.

The client bundler defines `process.env` as `{}` — `clientBuildEnvironmentDefines` emits that entry and then one define per `DSH_CLIENT_`-prefixed name. Every other name therefore reads as `undefined` inside a browser artifact, so the comparison could not hold there and the skip never happened in any shipped client. A store test named the behavior "does not deep-freeze wholesale state in production" and passed, because vitest runs unbundled where `NODE_ENV` is a real string; it proved the Node path and said nothing about the browser.

## Decision

The gate reads `process.env.DSH_CLIENT_BUILD_PROFILE === 'official'`, a name the client define set carries, so an official artifact reaches the skip. Tests, the dev server, and unbundled consumers keep the guard, which is where an accidental post-`set` mutation is worth catching.

The test asserts both directions in one case: with `NODE_ENV` stubbed to `production` the value is still frozen — the browser's situation — and only stubbing the official build profile releases it. The two sibling test names that also said "outside production" now say what they check.

## Alternatives considered

**Add `NODE_ENV` to the client define set.** It is not a `DSH_CLIENT_` name, and that prefix is the documented reservation for values allowed to reach browser artifacts. Widening it for one gate would put an unaudited name into every shipped bundle.

**Freeze unconditionally and delete the branch.** The freeze is a development aid for a mutation that TypeScript cannot catch, not a runtime invariant, so paying a deep walk on every wholesale set in shipped artifacts trades user-visible cost for nothing an end user benefits from.

**Read `import.meta.env.DEV`.** Vite defines it for `apps/web`, but `packages/client/*` are bundled by tsdown, so the name would be undefined in exactly the artifacts the gate exists for.

## Consequences

Official client artifacts stop deep-freezing the whole state tree on every wholesale `set()`. Any `process.env` read in Client source outside the `DSH_CLIENT_` prefix is `undefined` in the browser; the four other reads in `packages/client` all use that prefix.
