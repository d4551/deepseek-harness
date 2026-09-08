---
description: "axe-core accessibility auditing in real browsers, for test authors holding rendered UI to WCAG 2.2 A/AA."
kind: "package-library"
---

# @deepseek-ai/dsh-client-a11y

English | [中文](README.zh.md)

## Summary

`dsh-client-a11y` audits rendered client components against WCAG 2.0, 2.1, and 2.2 levels A and AA plus axe's best-practice rules. Chromium computes layout, contrast, and pseudo-elements using the product theme. Reports include violations, decided-check counts, and unresolved checks with their diagnostic data. The fixed rule set applies to every audited component.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Run `bunx vitest run --config vitest.client-browser.config.ts packages/test-support/client-a11y` to verify the browser audit engine. The browser lane discovers client suites that import this package and files named `*.browser.spec.ts` or `*.browser.spec.tsx`. Unit suites use jsdom where layout is unnecessary; a separate pixel regression verifies its installed native `canvas` peer.

Render a surface, audit it, and hold the floor with `accessibilityFailures`:

```text
const { baseElement } = render(<main><Button>Send</Button></main>)
const audit = await auditSurface('Button', baseElement)

expect(accessibilityFailures([audit], 100)).toBe('')
expect(audit.incomplete).toEqual([])
```

`auditSurface(surface, context)` returns violations, `passed`, `failed`, and `undecided` node counts, `undecidedRules`, and full `incomplete` results. `accessibilityFailures(audits, 100)` rejects empty audit sets, silent surfaces, violated nodes, unresolved checks, and scores below 100. An assertion on `incomplete` prints the full diagnostic data. `accessibilityScore(audits)` measures decided checks; `formatViolations(audit)` names each violated rule and affected element.

### Render inside a landmark

Page-structure rules cannot be satisfied by a component floating in a bare `<body>`. Render each surface inside the landmark a real page provides — a `<main>` wrapper is enough — so the audit reports component defects rather than the harness's own missing page frame.

### Derive the audited set

A hand-written list of audited components silently stops covering the next one. Derive the set from the package's own exports and assert that the audited names equal the exported ones, so a new component or icon is audited the moment it ships.

### What can go wrong

- **A check reports as undecided** — inspect `incomplete` for the affected nodes and reason. Overlapping text, obscuring animations, or unresolved image backgrounds can prevent a decision even in a browser. Repair the rendered state and rerun the audit.
- **A portaled surface escapes the landmark** — content rendered into `document.body` sits outside the wrapper. Give it the role it actually has (a modal overlay is a `dialog`) instead of excluding the rule.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

The module fixes the `axe.run` tag list, requests violations, passes, and incomplete results, and converts axe's per-rule node arrays into counts. Raw incomplete results and counts remain intact and do not enter the score. For axe's exact `controlsWithinPopup` review, `completedReviews` records native DOM evidence: each controlled ID resolves uniquely, the popup role matches `aria-haspopup`, and an expanded popup is visible and accessible. Every other incomplete check, and every popup review without that evidence, fails `accessibilityFailures`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `CLIENT_AXE_TAGS`, `clientAxeRunOptions`, `auditSurface`, `accessibilityFailures`, `accessibilityScore`, `formatViolations` |
| [`src/popup-review.ts`](src/popup-review.ts) | Native DOM verification of popup-reference reviews |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; the module owns no event stream or mutable data) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [UI primitives package](../../client/ui-primitives/README.md) — the audited component set and its accessibility suite.
- [Client test runtime](../client-runtime/README.md) — the jsdom bench that renders feature surfaces.
- [Testing policy](../../../docs/testing.md) — the accessibility tier and the lanes around it.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is browser-side test infrastructure; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how the auditing is consumed. They are current package constraints, not a task backlog.

- **Automated checks cover part of accessibility** — keyboard journeys, screen-reader behavior, and understandable content also require interaction review.
- **One surface at a time** — the module audits a DOM subtree a caller already rendered. It mounts nothing and knows nothing about slots, so a suite decides what a surface is and how to build it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
