# Agent Note: Root dependency floors complete by construction

Status: implemented

English | [中文](2026-09-03-root-dependency-floors-complete-by-construction.zh.md)

## Problem

[`scripts/live-stack-floors.ts`](../../../../scripts/live-stack-floors.ts) asserts that a declared dependency range sits at or above a floor, but the families it checked were listed by hand. A dependency added to the root manifest without a matching entry was compared to nothing, so it shipped at whatever version its author installed and stayed there. Nothing failed when a dependency arrived without a floor, so the list could only grow by someone remembering to grow it.

`declaredRange()` compounded that. It matched `"name": "value"` with a regular expression over the raw manifest text, so the first such pair anywhere in the file won, `scripts` included. The root manifest declares a `knip` script (`knip --treat-config-hints-as-errors`) above its `knip` dependency, so the gate read that command line as knip's version range and threw `unparseable version range` the first time anything asked for it.

## Decision

`ROOT_DEPENDENCY_FLOORS` names every non-workspace dependency the root manifest declares, mapped to the version the repository ships. `unflooredRootDependencies()` fails when the manifest declares a dependency the map does not, so adding one forces stating the version it may never fall below. Families that workspace manifests also check reuse the exported floor constant instead of repeating the number.

The root manifest is the scope because it is where the toolchain is declared: the compiler, bundler, test runner, linter, mutation runner, and documentation tooling all resolve from there, and a stale declaration there weakens every gate below it. `workspace:` ranges are excluded because they name packages in this repository, whose versions move with the release, so a registry floor would describe nothing.

`declaredRange()` parses the manifest and reads `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies` in that order. A malformed manifest, a non-object dependency group, or a non-string range throws instead of resolving to `undefined`.

The completeness rule found three stale declarations, raised in the same change: `jscpd` `^5.0.16` to `^5.1.1`, `knip` `^6.33.0` to `^6.34.0`, and `oxlint` `1.80.0` to `1.81.0`. `@types/node` stays at `^26.4.0`. Version `26.4.1` exists, and [`bunfig.toml`](../../../../bunfig.toml)'s `minimumReleaseAge` of 86400 seconds refuses a release younger than a day; that supply-chain control outranks a patch bump, so the floor stays where the policy allows the install to land.

## Alternatives considered

**Query the registry for each dependency's latest version.** It catches staleness with no curated map, but it needs network access inside a gate, it returns a different answer on different days, and it turns any upstream publish into a red build on an unchanged tree.

**Require a floor for every dependency in every workspace manifest.** Package manifests declare mostly `workspace:` ranges plus a few runtime dependencies each, while the toolchain that sets every gate's strength is declared at the root. Widening the rule adds hundreds of entries to catch the same drift.

**Keep the text scan and exclude `scripts` from it.** The collision reaches further than `scripts`: any manifest field holding a `"name": "value"` pair can shadow a dependency of that name. Reading the dependency groups removes the class rather than one instance of it.

## Consequences

Adding a root dependency now requires naming its floor in the same change, and raising one requires raising the floor with it. That cost buys a list that cannot fall behind unnoticed, because the map is checked against the manifest on every run and an omission fails.

Repairing `declaredRange()` reached every other caller. `rangeMisses()` now reads real dependency declarations across all workspace manifests, so a script or any other field sharing a dependency's name can no longer be compared as that dependency's version.
