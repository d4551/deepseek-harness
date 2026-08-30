# Agent Note: Typert entry-surface validation accepts every Node-legal exports shape

Status: implemented

English | [中文](2026-08-30-typert-entry-surface-node-legal-exports.zh.md)

## Problem

`validatePackageEntrySurface` rejected two classes of valid packages. A package whose `package.json` declared no `exports` field was admitted only when it also declared `types`, even though the analyzer already discovers source exports directly from package sources. Node-legal `exports` shapes beyond the subpath map — a bare string, a condition object, or an array of fallbacks — were rejected as malformed, so real-world manifests aborted analysis before any type graph was built.

## Decision

Entry-surface validation now mirrors Node's own `exports` grammar. A package without `exports` is admitted as-is; its source exports are discovered directly. A present `exports` field may be a string, a condition object, a subpath map, or an array of fallbacks; validation throws only when the field is `null` or neither object nor string. Target-existence and package-root containment checks still apply to every source-bearing entry, and generated artifact and data entries (`./typert`, `.json`, `.yml`, wildcards) remain exempt from target checks.

## Alternatives considered

**Keep the `types` requirement for exports-less packages.** Rejected: source discovery already covers those packages, so the requirement only rejected valid manifests without adding information the analyzer uses.

**Reject string and array `exports` as unsupported.** Rejected: both are Node-legal and appear in published packages; rejecting them made the analyzer unusable against real dependency trees.

## Consequences

The analyzer admits manifests it previously aborted on, and the fixture suite covers string, condition-object, subpath-map, and exports-less packages. Test updates in the same change also absorb TypeScript 7 behavioral deltas: malformed `tsconfig` files no longer abort discovery, and project-reference discovery differs from TypeScript 6 in edge cases the fixtures pin.
