# Agent Note: axe over every exported client primitive

Status: implemented

English | [中文](2026-08-29-client-accessibility-lane.zh.md)

## Problem

Nothing measured whether the UI this repository ships is usable without sight or a mouse. The client lane rendered components and asserted their markup, so a button whose only content was a chevron, or an overlay that made the application inert without saying what it was, passed every check the repository had. Accessibility defects of that kind are invisible to snapshot and behaviour tests: the DOM is exactly what the component meant to produce.

## Decision

[`dsh-client-a11y`](../../../../packages/test-support/client-a11y/README.md) runs axe-core over a DOM a suite already rendered, and `packages/client/ui-primitives/tests/accessibility.client.spec.tsx` holds every exported component of the primitives package to it. The lane runs inside `bun run test`, so it is in every aggregate that runs the unit tier.

- **The rule set is fixed in the harness**, not passed per call: WCAG 2.0 and 2.1 levels A and AA plus axe's best-practice tags. A suite cannot narrow the bar it is measured against, and a unit test pins the list.
- **The audited set is derived from the package's exports**, and the suite asserts that the audited names equal the exported ones. A new component or icon is audited the moment it ships rather than when someone remembers to add it to a list. React `memo` wrappers count as components, or a memoized export would slip through the name check.
- **Surfaces render inside a `main` landmark.** Page-structure rules cannot be satisfied by a component floating in a bare `body`; without the landmark the audit reports the harness's missing page frame as a defect in every component.
- **The floor equals the recorded score.** Every decided check passes, so the floor is 100 and any failed check fails the run. A floor below the record would let exactly that many regressions land while still reading as a floor.
- **Undecided checks are excluded from the score, and which rules are undecided is asserted.** jsdom computes no layout, so `color-contrast` decides nothing; the suite asserts the undecided set is exactly that rule, because a newly undecidable rule would otherwise leave the number untouched instead of failing.
- **Every surface must decide at least one check.** A surface that decided nothing scores 100 for free, so the aggregate carries no evidence anything was examined without this.

## Why a separate package

axe-core touches jsdom globals when it loads. Reaching it through [`dsh-client-test-runtime`](../../../../packages/test-support/client-runtime/README.md) put it in front of every client spec and moved unrelated layout measurements — two `ui-chat` scroll-anchoring tests began failing with no change to their subject. The harness therefore lives in its own package that only the accessibility suite depends on.

## What the audit found

Two real defects, both fixed rather than accommodated:

- `DisclosureRow`'s toggle button contained only a chevron, so assistive technology announced an unnamed control. The row's own title now names it.
- `OnboardingSurface` covered the application and set the root `inert` while presenting as decoration. It is a `dialog` with `aria-modal` and a required `label`; the prop is a breaking API change, and the component has no product callers today.

## Alternatives considered

**Add axe assertions to the existing client specs.** Every feature suite already renders its subject with the right context, so the coverage would be wider for less new code. It also puts axe-core in front of every client spec — the exact failure that forced the package split — and leaves the audited set as whatever each suite happened to render, which is the list-that-goes-stale problem the derived set exists to avoid.

**Audit in the browser lane instead of jsdom.** Chromium decides colour contrast, which jsdom cannot, so the lane would have no undecided bucket at all. It also costs a built frontend per run and puts the fastest-moving assertions in the slowest lane. The jsdom lane gets the structural rules cheaply; contrast stays the browser lane's to prove.

**Score violations only, with no aggregate.** The zero-violation assertion is what actually gates, so the score adds nothing a suite must satisfy. It is kept because it is the number a reader asks for, and pinning it to the recorded value is what stops it drifting into decoration.

## Consequences

Every exported primitive is held to WCAG A and AA on every unit run: 97 surfaces, 1138 decided checks, none failing, with `color-contrast` the only rule jsdom cannot decide. A new primitive cannot ship unaudited, and a regression fails the run rather than lowering an average.

The lane covers `ui-primitives`, `ui-attachment`, `ui-user-questions`, `ui-goal`, `ui-workspace`, `ui-tool`, `ui-chat`, `ui-trajectory`, `ui-settings-general`, and `ui-conversation`. The first audits what a package exports; the second cannot, because it exports a plugin and composes its components internally, so its surfaces are mounted in the states a user meets — a rail holding pending images, the drop overlay, the lightbox, and a message image. The third is a form the user answers under time pressure, audited inside the suite that already renders it rather than in a separate file, because its setup is what makes the surface real. All of them hold the same floor.

**A surface is audited inside the structure ARIA requires of it.** A session row is a `treeitem`, which must sit in a `tree`; the product's browser supplies that container, so auditing the row alone reported `aria-required-parent` against a defect that does not exist. The audit mounts the container the product mounts. Suppressing the rule instead would have hidden the case where that container is genuinely missing.

**The undecided set is recorded per surface, not assumed.** The primitives lane leaves `color-contrast` undecided because jsdom computes no layout, but a surface that gives axe no text-on-background pair leaves nothing undecided at all — the context meter asserts an empty set. Each lane asserts what it measures, so a newly undecidable rule fails somewhere rather than silently leaving a score.

**An audit reads the whole document, so it audits only what it mounted.** Suites that render without an `afterEach` cleanup leave earlier trees in the body, and those landmark-less leftovers are not the surface's defect. The approval-command audit clears them before mounting rather than excusing the `region` rule they trip.

The remaining composed surfaces — chat, settings, workspace — are still unaudited. Each needs its feature suite's context to render, which is the work this note leaves open, and it is most of the client: ten of the 43 packages under `packages/client/` are audited today.
