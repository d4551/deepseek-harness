# Agent Note: Hit-target floor reads units, merged selectors, and padded boxes

Status: implemented

English | [中文](2026-09-06-hit-target-units-merge-and-padding.zh.md)

## Problem

The WCAG 2.5.8 check in [`scanUiSsot`](../../../../scripts/client-ui-ssot.ts) reported an empty corpus while seventeen authored pointer targets shipped under 24 CSS pixels. Three separate readings let them through.

Sizes were matched as `(\d+)px`, so `rem` was invisible. `model-selection-card.module.css` sized its toggle `width: 2.25rem; height: 1.25rem` with `cursor: pointer` in the same rule — a 36×20 control, the exact case the check was written for, passing on its unit.

The check read one rule at a time, so a control split across rules met neither half. `SubagentHeaderLineage.module.css` sized `.disclosure, .disclosureSpace` at 14×18 in one rule and gave `.disclosure` its `cursor: pointer` in the next; neither rule was a finding on its own.

The check required a declared `width`/`height`, and the common button shape declares neither. Fourteen controls were sized entirely by padding, border, and line box — `.retry` at 16px, `.button` at 22px, `.pill` at 22px — and produced no sizes to compare.

## Decision

Sizes resolve `px` and `rem`, including fractions, with `rem` at the 16px initial root font size that applies because no sheet under `packages/client` or `apps/web` sets one. `em` is not converted: it resolves against the element's own inherited font size, which a stylesheet scan cannot know.

Declarations merge onto the compound selector they target before the check runs, so geometry in one rule meets `cursor: pointer` in another on the element they share. Trailing pseudo-classes are stripped because `:hover` styles the same box. Rules naming a user-agent pseudo-element are dropped before the merge, so `::-webkit-search-cancel-button` geometry is never attributed to the control it decorates.

A target the sheet never sizes is bounded instead of skipped: `paddedHeightFloorPx` adds vertical padding and border width to a single line box, where the line box is the declared `line-height` (absolute or unitless multiple) and otherwise the declared `font-size`. The bound reports only boxes that cannot reach 24px, and any part it cannot resolve — `var()`, a percentage, `em`, a missing `font-size` — makes it decline to bound rather than read the missing part as zero.

All seventeen controls were raised to the floor: `min-height: 24px` with inline-flex centering where a layout mode was free to change, vertical padding where `text-overflow: ellipsis` needed the existing one, and explicit geometry for the two rules that declared it. The toggle's track went to 36×24 with a 20px thumb and its travel adjusted to match.

## Alternatives considered

**Convert `em` at 16px too.** Rejected: the value depends on the inherited font size, so a computed number would be one the page never uses — findings nobody can act on, and misses where the inherited size is larger.

**Report every target that declares no explicit size.** Rejected: most controls are correctly sized by their padding, and a check that fires on all of them says nothing. The bound answers whether this one can reach 24px.

**Model the WCAG 2.5.8 spacing exception.** Rejected for the same reason as when the named-selector allowlist was replaced: the floor is declared geometry on the target, and spacing would let two adjacent undersized targets pass each other.

**Merge across files.** Rejected: a CSS Module's class names are local to its file, so a merge across files would join selectors that never meet in the DOM.

## Consequences

A control sized in `rem`, sized across sibling rules, or sized only by its padding is now measured. A rule the scan cannot bound is silently accepted, so a control whose padding comes from a custom property still needs a declared `min-height` to be covered — the check states the floor it can prove, not every floor. Raising or lowering the 24px number remains a change to `HIT_TARGET_MIN_PX` and the [web-styling](../../../../docs/web-styling.md) sentence together.
