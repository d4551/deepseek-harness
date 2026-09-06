# Agent Note: Removing the focus ring requires replacing it

Status: implemented

English | [中文](2026-09-06-focus-ring-removal.zh.md)

## Problem

[`base.css`](../../../../packages/client/ui-theme/src/styles/base.css) supplies a keyboard ring by element and by role, and its own comment says a component's `:focus-visible` beats it on specificity. Six component rules turned that ring off. Five substituted something — an inner element's outline, a pseudo-element overlay, an icon colour — and one, `.detailsResizeHandle:focus-visible` in `TrajectoryTable.module.css`, was a bare `outline: none` that left a keyboard user no indicator on a resize handle. Nothing measured the difference.

Separately, `.input:focus-visible` in the plugin settings fields made a 1px `border-color` change its entire focus indicator, and `TeamAction` moved focus into a `role="dialog"` panel with no `Escape` handler while both sibling actions (`JobListAction`, `WorkspaceRootsAction`) had one.

## Decision

A `:focus-visible` rule whose whole body turns the ring off is a finding unless another rule in the same sheet names that same focused selector. That is the objective half of the question: a replacement painted on an inner element (`.b:focus-visible .wrap`) or through a pseudo-element (`.row:has(> .e:focus-visible)::after`) mentions the selector, and an unrelated rule does not. Whether a substituted colour is a *sufficient* indicator is a judgement the scan does not make, so it reports only the case with no replacement at all.

The three defects are fixed rather than exempted: the resize handle takes the theme ring inset, the settings input keeps its brand border and gets the ring back beside it, and `TeamAction` closes on `Escape` through the `closePanel` it already had.

## Alternatives considered

**Report every `:focus-visible` that substitutes colour alone.** Rejected: `.sourceBlockJumpTarget` recolours its icon and `.requestBoundaryControl` recolours a pseudo-element, both deliberate. Sufficiency needs a contrast measurement against the resolved theme, which a stylesheet scan cannot do, and a rule that guessed would fire on working indicators.

**Ban `outline: none` under `:focus-visible` outright.** Rejected: an inset or overlay ring legitimately starts by clearing the user-agent one, and five of the six rules do exactly that.

**Give `TeamAction` a focus trap.** Rejected: the sibling actions dismiss on `Escape` and let Tab leave, and three popovers in one header behaving differently is the defect. Matching them is the fix.

## Consequences

A component that clears the ring now has to paint one somewhere the sheet can see. A replacement painted from a different stylesheet — a parent package's sheet reaching in — would read as no replacement, which is the same file-local limit CSS Modules already impose on the rest of this scan.
