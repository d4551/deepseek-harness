# Agent Note: Root README orientation, and a gate under its badges

Status: implemented

English | [中文](2026-09-02-root-readme-orientation-and-badge-gate.zh.md)

## Problem

The root README opened on what `dsh` is built from — Cordis, the everything-is-a-plugin architecture, the fork's toolchain pins — and never on what it does for the reader in front of it. Someone arriving from a link had to reach the architecture guide before learning that a harness is the layer between them and a model, or that a capability arrives as three separable roles. The two facts that explain every other rule in this repository, model-visible ⟺ logged and the Service Definition / Provider / Consumer split, appeared nowhere on the page a first-time reader lands on.

A README also states versions, and nothing reads them. The fork pins TypeScript 7.0.2, bun 1.4, and Vitest 4 in `package.json`; a bump moves those and leaves any prose claim behind, asserting a version the repository stopped using, in the one file the most people read and the fewest people test.

## Decision

The README carries a badge line, an `Explain like I'm five` section, and a mermaid chart of one turn, in that order, before the fork-specific `This checkout` section.

`scripts/root-readme-badges.spec.ts` derives each version badge from `package.json` — `typescript` and `vitest` from the dependency ranges, bun from `packageManager` — and asserts the two language sides carry byte-identical badge markup, so a bump cannot land in one and not the other. `run-gates.ts` runs it in the same `doc-standard-tests` leaf as `doc-standard.spec.ts`, which puts it in `test:docs` and `doc-sync`.

The badges sit on one physical line because `verify-md-wrap` owns one-line-per-paragraph, and the spec reads them out of that line rather than off separate lines.

The chart's node labels are English on both sides, following the existing bilingual mermaid convention in `docs/agent-lifecycle.md`: the diagram body is identical in both files and only the surrounding prose is translated.

## Alternatives considered

**A badge for the workspace package count.** 251 is a striking number for an everything-is-a-plugin harness, and it drifts every time a package lands. A count badge is only honest with a gate that updates it, and a gate that updates a number nobody reads buys less than it costs in churn on unrelated changes.

**Leaving the badges ungated.** Cheaper by one file, and it is exactly how the claim rots: the prose that states a version is the prose no test reads, so the bump that moves it is the bump nobody notices.

**Translating the chart's node labels.** Rejected for the same reason the existing sequence diagrams do not: the labels are package and event names — `agent-loop`, `system-prompt`, `llm` — and translating them detaches the picture from the tree it describes.

## Consequences

A toolchain bump now fails a documentation gate until the README states the version it moved to, in both languages. That is one more file to touch on a bump, and it is the point.

The chart states four plugin roles and one seam list. It is a picture of the loop, not of the tree, so it does not move when a package lands; when the loop's shape changes it must, and `docs/architecture.md` already requires that change to be documented.
