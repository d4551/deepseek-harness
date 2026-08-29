# Agent Note: Historical client-runtime seed keys for out-of-tree bundles

Status: implemented

English | [中文](2026-08-30-client-runtime-seed-alias.zh.md)

## Problem

Already-built out-of-tree client bundles such as `dsh-context-doctor` call `require("@deepseek-ai/dsh-client-runtime/client")` for `defineStore`. The shell never seeded that specifier. `defineStore` lives on `@deepseek-ai/dsh-client-store`, so the factory throws the module-table miss and the boot page reports a failed plugin.

## Decision

`getStaticModules` answers `@deepseek-ai/dsh-client-runtime` and `@deepseek-ai/dsh-client-runtime/client` with the same singleton as `@deepseek-ai/dsh-client-store`. Those keys are not `PLATFORM_MODULES` words, so first-party tsdown does not treat them as baseline externals and there is still no `dsh.client.provide` alias protocol. New first-party and rebuilt out-of-tree code imports `@deepseek-ai/dsh-client-store`.

## Alternatives considered

**Add the historical specifier to `PLATFORM_MODULES`.** Rejected because that would grow the first-party external baseline for a name that is not a workspace package, which is the `dsh.client.provide` alias the module-graph rules refuse.

**Rebuild or patch every installed out-of-tree bundle.** Correct for new releases of those plugins, and still required when they import APIs the store singleton does not export. It does not unstick already-built artifacts that only need `defineStore`.

## Consequences

A historical bundle that required a different export from `dsh-client-runtime` still fails loudly. `apps/web` must be rebuilt after this seed change because `dsh web` serves the Vite `dist/`.
