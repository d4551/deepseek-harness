# Agent Note: The trajectory timing switch users could not reach

Status: implemented

English | [中文](2026-09-01-trajectory-wall-clock-switch.zh.md)

## Problem

`TrajectoryToolbar` shipped its wall-clock timing switch with a `hidden` attribute from the commit that introduced it, and nothing recorded why. `onActualTimeChange` is the only caller of `setActualTime`, and that switch is the only thing that fires it, so `actualTime` stayed `false` for every session. `TrajectoryView` derives `timelineMode` from the pair `actualDuration` × `actualTime`, which left two of its four modes — `'actual'` and `'time'` — unreachable in the product. Their implementations were live the whole time: `deriveTrajectoryTimeline` handles `'actual'`, `TrajectoryTimeline` styles `[data-equal-duration]` from `'time'`, and a unit test exercised `'actual'` directly. The toolbar also carried complete `.control`, `.controlTrack`, and `.controlThumb` styling for a control no user could see, and the `toolbar.actualTime` copy sat translated in both dictionaries.

## Decision

The switch renders. Removing `hidden` is the whole change: the control, its handler, its styling, its copy, and both timeline modes already existed and are unchanged. A view-level test renders `TrajectoryView`, finds the switch by role, and asserts a click flips `aria-checked`, so the path from the control to the state `timelineMode` reads is covered rather than assumed.

## Alternatives considered

**Delete the switch and the two modes it selects.** A dead control is real debt, and removal is the right answer when a half-built feature has no consumer. This one is not half-built: the mode derivation, the timeline styling, and the bilingual copy are all complete, so deleting them would give up working behavior to tidy away one attribute.

**Leave it hidden and record the reason.** There is no reason to record. The attribute predates any note, no test covers the control, and the props it feeds are documented as a user-facing choice between complete wall-clock timing and idle-compressed timing.

## Consequences

`snapshots/web/navigation-panes/trajectory.expected.md` gains the switch, because `hidden` had kept it out of the accessibility tree the golden captures. That file is re-recorded with `bun run test:web:refresh`, which needs a real server; `bun run test` and `bun run test:gui` are unaffected.
