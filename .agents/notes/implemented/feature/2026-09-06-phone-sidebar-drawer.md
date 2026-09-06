# Agent Note: The phone sidebar opens as a drawer over the centre

Status: implemented

English | [中文](2026-09-06-phone-sidebar-drawer.zh.md)

## Problem

[`columns.ts`](../../../../packages/client/ui-layout/src/client/columns.ts) states that the sidebar never concedes width: the centre absorbs every squeeze. Above `SIDEBAR_AUTO_COLLAPSE` that holds, and at 768 a re-expand still leaves 488px of centre. Below it the arithmetic runs out. Measured against the shipped composition in Chromium, expanding the sidebar at 375px produced `280px | 95px | 0`: a 95px centre that clipped the greeting to "to the / nknown", reduced the composer to a sliver, and squeezed the model-select trigger to 17×28 — under the 24px target floor the CSS scan holds everywhere else. 390px gave 110px and 23×28. A phone user reaches that state from the rail's own toggle.

Nothing measured it. Every other web scenario runs between 1100 and 1680px wide, so no committed test rendered the shell below a desktop window.

## Decision

`SIDEBAR_OVERLAY` is 640px. Below it an expanded sidebar is drawn over the centre instead of taking a column: the solver receives a closed preference, so the grid keeps the rail track and the centre stays the width it had while collapsed, and the sidebar column is positioned absolutely at its drawer width with a scrim covering what it hides. 640 is the boundary because 768 still leaves a usable centre while 375 and 390 do not.

Each column is pinned to its own track (`grid-column: 1|2|3`). Taking the sidebar out of flow otherwise lets auto-placement slide the centre into the rail track, which is what the first version of this change did: the drawer opened, the centre reported the right width, and the composer was rendered into 56px. The probe caught it; the committed scenario now asserts it.

The scrim is a real button carrying `sidebar.closeOverlay`, so a keyboard reaches it in order after the drawer's controls, and it sits one z-step below the drawer (`--dsw-z-shell-drawer`) so it dims the centre rather than the panel that opened it.

## Alternatives considered

**Let the sidebar concede below the breakpoint.** Rejected: "the sidebar never concedes" is the contract the drag clamps and the concession chain are written against, and a width that changes underneath a drag is the behaviour that contract exists to prevent.

**Make the drawer full-width.** Rejected: the rail is how a phone user gets back, and a full-width panel with no visible page behind it reads as a navigation, not a drawer.

**Raise `CENTER_MIN` so the solver refuses to squeeze that far.** Rejected: the solver's final fallback exists precisely because a viewport can be smaller than the minimum, so a higher floor moves the number without removing the state.

## Consequences

`packages/client/ui-layout` now owns a second breakpoint, and both are stated in `columns.ts` rather than in a stylesheet. A scenario that drives the sidebar below 640px sees a drawer, and `apps/web/tests/responsive-shell.e2e.ts` holds the shell at 375, 768, 1024 and 1440: no horizontal overflow, no visible control under 24px, the expected track for the width, and the drawer keeping the centre's width. Setting `SIDEBAR_OVERLAY` to 0 fails that scenario, which is how the assertion was proven.
