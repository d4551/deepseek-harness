# Agent Note: Shared Client row primitives

Status: implemented

English | [中文](2026-09-03-shared-client-row-primitives.zh.md)

## Problem

Ten UI components were written more than once each, across eleven Client packages and one extension.

The copies were exact. The round transparent icon button existed four times, in `ui-sidebar`, `ui-workspace`, `ui-chat`, `ui-message-feedback`, `ui-goal`, and `extensions/ui-cordis`. The inspect pill existed four times, the meta separator dot seven, the row summary five. Two of them said so in their own comments: `packages/client/ui-tool/src/client/tool/toolviews/bash-sample.module.css` recorded that migrating onto `DisclosureRow` would collapse them into one, and `packages/client/ui-message-feedback/src/client/MessageFeedbackActions.module.css` recorded that its action button copied `ui-chat`'s.

Nothing failed on this. `bun run duplication` reads TypeScript, not CSS, and no single-file rule can see a body that a different package declared. The copies drifted the way copies do: the same pill carried two different `prefers-reduced-motion` spellings, and the same summary carried two different error-ink hooks.

## Decision

Six primitives own what was copied: `FlowRow`, `RowSeparator`, `RowSummary`, `InspectPill`, `ResultText`, and `GlyphButton`, all in [`packages/client/ui-primitives`](../../../../packages/client/ui-primitives/README.md) and exported from the package's published entry.

`GlyphButton` is one component with a `surface` variant rather than four components. All four call sites are the same round transparent icon button; the box and ink differences between them are drift the design has not reconciled, and the constraint here was pixel parity, so the base rule holds only what all four share and each variant adds its own geometry. Splitting them into four primitives would have preserved the drift while claiming it was intentional.

Per-site differences moved into props where they were expressible — the summary's error ink is a `tone` prop rather than two private CSS hooks — and stayed local where they were genuine. `CordisPanel` guards its hover with `:not(:disabled)` and `GoalBar` does not, so both hover rules stayed with their owners.

Two rules needed a specificity bump rather than a move. A `transition: none` under `prefers-reduced-motion` sat at (0,1,0) in `SkillRow` and `CordisDefineRow`, exactly tied with the primitive's `transition` now that the primitive lives in another package's sheet, which would have left bundle order to decide. Both became `.card .inspectButton` at (0,2,0).

[`scripts/client-ui-ssot.ts`](../../../../scripts/client-ui-ssot.ts) is what keeps this from regrowing. A rule body of `DUPLICATE_RULE_DECLARATIONS` (six) declarations or more, appearing in two `.module.css` files, is reported as `duplicated-rule`. Six is measured, not chosen for convenience: on this corpus every duplicated body below six declarations is a generic idiom two unrelated components arrive at independently — a flex column with one gap, an ellipsis clamp, a colour and size and line-height text tier — and every body at six or above is one named component written twice. The ellipsis clamp appears at three, four, and five declarations, so no lower threshold separates copying from convergence. The narrower `duplicated-shell` band stays at three declarations for grid rows carrying inter-child spacing, so the small case a six-declaration floor lets through is still covered where it matters.

## Alternatives considered

**Share the CSS rather than the component.** `composes: … from` compiles to an empty class in this pipeline, which `packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx:20` already records, and a `.module.css` has no package export entry. Sharing the React component is the only channel that exists.

**Global theme classes, as `visually-hidden.css` and `z-scale.css` use.** Right for a single-property utility; wrong for a control with structure, state attributes, and an SVG child, which is a component and belongs in the component package.

**Migrate `BashRow` onto the existing `DisclosureRow`.** Its own comment proposes exactly this, and it would have removed one more copy. It also drops `data-sample`, `data-variant`, and `data-state`, moves the visually-hidden status span after the title, and adds `width: 100%; min-width: 0` to the card — a DOM and visual change, when the constraint was that every call site render identically. `FlowRow` collapses the duplicated body and leaves both DOMs byte-identical.

**Raise the threshold until the corpus passes.** That is the move this detector exists to prevent, and the measurement above is what makes six defensible rather than convenient.

## Consequences

A control now has one owner, so a change to the icon button reaches every surface that uses it instead of one of six. The cost is that a call site wanting to differ states it as a prop, and a call site whose override lives in another package's sheet has to think about specificity — two rules already needed that.

The extraction surfaced dead code the copies had hidden: `HeroShell.module.css` carried a modal input, action, and error block that `EmptyHero.tsx`, its only importer, never referenced. It is gone.

One name changed under test pressure. The primitive was `IconButton` until `packages/client/ui-primitives/tests/icons.client.spec.tsx` audited it as a glyph, because that suite selects exports by the repository's `Icon*` convention. `GlyphButton` says what it is without claiming to be an icon.
