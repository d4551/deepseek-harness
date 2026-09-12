# Agent Note: Coverage exclusions declare structural or marked debt

Status: implemented

English | [中文](2026-09-06-coverage-debt-markers.zh.md)

## Problem

[`docs/testing.md`](../../../../docs/testing.md) told readers the coverage exclusions in [`vitest.config.ts`](../../../../vitest.config.ts) carry "a marked debt list (`TODO(gui)`, `TODO(inspector)`, `TODO(webworker)`) waiting on a browser-grade lane". The repository-wide count of those markers was zero. Nothing carried one, nothing checked for one, and the 125 exclusions were separated from each other only by prose, so the debt could be neither enumerated nor ratcheted.

Five of those entries named paths no longer in the tree: `packages/self-modification/*/src/**/*.{ts,tsx}` (a package group renamed to `packages/extensions/`, which the repository-layout list in `AGENTS.md` also still named), a `ui-workspace` component that moved under `rows/`, two deleted `ui-chat` modules, and an Inspector plugin entry. Each excused nothing while still reading as an exemption the gate deliberately granted.

## Decision

An exclusion is structural or it is marked debt. `STRUCTURAL_EXCLUSIONS` in [`coverage-debt.ts`](../../../../scripts/coverage-debt.ts) lists the fifteen globs that are structural — no runtime coverage to measure, an executing composition in a Worker, browser realm, or subprocess that unit-process V8 cannot observe, or generated Host-for-Client code that exists only in `lib` and is executed by the post-build smoke. Everything else is debt by default and has to carry one of the three documented markers, so a new exclusion joins the debt inventory rather than the structural set by omission.

`bun run verify-coverage-debt` runs in the static lane and fails on conditions of one shape: a debt entry with no marker, a structural glob the config no longer excludes, a glob matching nothing in the tree, a documented marker nothing uses, and — since [the measurement note](2026-09-12-coverage-debt-measurement.md) — an entry another entry already covers whole and a platform-conditional lane entry matching nothing. It prints the count per lane on success, in globs and in files, which is the number a ratchet moves. The markers were first spelled `TODO(...)`; that note renamed them to `DEBT(gui)`, `DEBT(inspector)`, and `DEBT(webworker)` because the contract forbids the old word inside a gate, and `bun run measure-coverage-debt` is the reading that says which entries can go.

Braced alternations are expanded before matching, because Node's glob has none and every braced exclusion would otherwise report as matching nothing. `packages/*/*/src/oxlint-contract-*.ts` is named as a transient: a killed executable lint-contract test can leave a source probe behind, and matching nothing is what a clean tree looks like.

Closing order for the `DEBT(gui)` debt runs largest first: `packages/client/ui-tool`, `ui-slots`, `ui-layout`, `packages/client/web`, and `packages/host/webserver` are whole-package exemptions, and each is one glob rather than a file list.

## Alternatives considered

**Correct `docs/testing.md` to describe prose comments instead.** Rejected: the claim was the better design. Markers make the debt greppable and countable; deleting the claim would have left 125 exclusions with no handle.

**Classify by path pattern rather than an explicit list.** Rejected: `packages/*/*/src/types.ts` and `packages/client/ui-tool/src/*` are both `packages/*/*/src` globs, and no pattern separates "no coverage to measure" from "waiting on a lane". The distinction is a judgement, so it is written down.

**Fail on any exclusion at all, ratcheting the list to empty.** Rejected: the structural entries are not debt and will never close, so a gate that counts them cannot reach zero and stops meaning anything.

## Consequences

Adding an exclusion means either arguing it into `STRUCTURAL_EXCLUSIONS` or marking the lane it waits on. Deleting a source file now fails the gate until its exclusion goes too, which is the case that produced the five dead entries. The printed inventory is the ratchet: it should only ever fall.
