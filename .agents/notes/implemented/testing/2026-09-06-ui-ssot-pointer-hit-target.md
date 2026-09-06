# Agent Note: UI SSOT hit-target floor covers authored `cursor: pointer` controls

Status: implemented

English | [中文](2026-09-06-ui-ssot-pointer-hit-target.zh.md)

## Problem

[`scanUiSsot`](../../../../scripts/client-ui-ssot.ts) enforced WCAG 2.5.8 24px geometry only on `button`, `[role=button]`, `.button`, and `.iconButton`. Compact controls that paint as other class names and set `cursor: pointer` — font-size stepper arrows, attachment-rail remove, trajectory toolbar chips, JSON-tree expander and copy — sat below 24px and the live corpus stayed empty.

## Decision

A CSS rule is an authored pointer target when its selector is one of those button names **or** its body sets `cursor: pointer`. Any declared `(min-)width` / `(min-)height` below 24px on that rule is a `hit-target` finding. User-agent pseudo-elements (`::`), native `input` / `textarea` / `select`, and `pointer-events: none` are not authored compact buttons (native checkboxes, `::-webkit-search-cancel-button`, keyboard-only ticks whose parent rail owns the pointer). Injected unnamed `.chip { cursor: pointer; width: 16px }` fails; the live client/web corpus is empty of those findings. The 24px product rule remains in [`docs/web-styling.md`](../../../../docs/web-styling.md). Axe-core still owns runtime WCAG 2.5.8 on mounted DOM via [the client accessibility lane](2026-08-29-client-accessibility-lane.md); this collector owns declared CSS geometry.

## Alternatives considered

**Keep the named-selector allowlist.** Rejected: it is how 17×12 stepper arrows and 18×18 remove chips passed while `.iconButton` at 24px was the only class the scan could see.

**Flag every rule with a sub-24px width or height.** Rejected: glyphs, tracks, and caption metrics are not pointer targets.

**Implement the WCAG 2.5.8 spacing exception in the collector.** Rejected: the floor is declared CSS geometry on the target rule, the same as the named-button case. Spacing would let two overlapping undersized hits pass.

## Consequences

Raising or lowering the 24px floor is a change to `HIT_TARGET_MIN_PX` and the web-styling sentence together. A new compact control must declare at least 24px on the same rule that makes it a pointer target. Split rules (`cursor` on `.root`, `width` on `.sidebar`) still need the size on a matching pointer-target rule; that split remains a named coverage gap.
