# Agent Note: Motion durations take the collapsible token

Status: implemented

English | [中文](2026-09-06-literal-motion-durations.zh.md)

## Problem

[`base.css`](../../../../packages/client/ui-theme/src/styles/base.css) collapses `--ds-transition-duration`, `-fast`, and `-slow` to `0.01ms` under `prefers-reduced-motion: reduce`. That is the whole mechanism: a duration written any other way is motion the setting cannot reach.

Three declarations across the client used the token. Forty-five did not — thirty stylesheets stating `120ms`, `.16s`, `220ms`, `0.4s`, and a `1000ms` toast fade, plus one `transition: 'transform 120ms ease'` inside a TSX style object, where no media query can reach it at all. [`docs/web-styling.md`](../../../../docs/web-styling.md) requires reduced-motion behavior when adding transitions; nothing measured it.

The existing `reduced-motion` detector only answered `animation` declarations carrying `infinite`. Every transition, and every finite animation, was outside its scope.

## Decision

A `transition` or `animation` in client CSS states its duration through `--ds-transition-duration*` or is answered by name in a `prefers-reduced-motion` block. The detector reads each comma-separated layer of the value, because a timing function carries commas of its own and `cubic-bezier(0.2, 0.8, 0.2, 1)` is one layer rather than four. Within a layer only the first time counts: the duration comes before the delay, so a toast whose hold is `var(--dsh-toast-hold, 3000ms)` states its duration through the token even though a literal appears later.

An endless animation stays the existing rule's finding, so one selector never reads as two problems. `stopsTransition` extends the guard vocabulary that `stopsAnimation` already carried: `transition: none`, or a stated duration at or under a millisecond, and every stated time must be that short — a guard that shortens one property and leaves another moving has not stopped the motion.

A TSX style object is checked separately rather than by parsing TSX as CSS. It carries no media query, so a literal duration there cannot be guarded under any circumstances; the fix is a CSS Module class, which is what the model-list chevron now uses.

The forty-five declarations were mapped onto the existing three-step scale: at or under 120ms to `-fast`, up to 250ms to the base token, above that to `-slow`. Two sidebar assertions naming `150ms` were obsolete behavior and were changed with the sheet.

## Alternatives considered

**Flag only transform and position transitions.** Rejected: the theme collapses every duration in the scale, so a colour fade that keeps its literal is inconsistent with the mechanism the theme already committed to, and the split would need a per-property list nobody maintains.

**Require a `prefers-reduced-motion` block per file instead of the token.** Rejected: it duplicates in thirty sheets what one theme rule already does, and a per-file guard drifts from the rule it is supposed to answer.

**Keep the literal durations and widen the theme collapse with `*`.** Rejected: `@media (prefers-reduced-motion: reduce) { * { transition: none } }` overrides component intent wholesale, including transitions a component deliberately keeps, and it cannot reach a TSX style object either.

## Consequences

Timing moved slightly where a literal did not sit on the scale: `140ms` and `180ms` now run at `0.2s`, `0.4s` at `0.3s`. A component needing a duration off the scale adds a fourth token to the theme rather than a literal, so the collapse keeps reaching it. A motion value the scan cannot read as a duration — one taking its time from another custom property — is accepted, so the check states the motion it can prove is unreachable, not every such case.
