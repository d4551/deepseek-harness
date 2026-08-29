---
description: "axe-core accessibility auditing for the jsdom client lane, for test authors holding rendered UI to WCAG A/AA."
kind: "package-library"
---

# @deepseek-ai/dsh-client-a11y

English | [中文](README.zh.md)

## Summary

`dsh-client-a11y` runs axe-core over a DOM a client suite already rendered and reports what it found: the violated rules, the rule-node checks that passed and failed, and one aggregate score across every surface a suite audited. The rule set is fixed here — WCAG 2.0 and 2.1 levels A and AA plus axe's best-practice tags — so no suite can narrow the bar it is held to. It is a separate package rather than part of [`dsh-client-test-runtime`](../client-runtime/README.md) because axe-core touches jsdom globals when it loads: importing it into the shared bench put it in front of every client spec and moved unrelated layout measurements.

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

Render a surface, audit it, assert that nothing was violated, and hold the aggregate score:

```text
const { baseElement } = render(<main><Button>Send</Button></main>)
const audit = await auditSurface('Button', baseElement)

expect(formatViolations(audit)).toBe('')
expect(accessibilityScore([audit])).toBeGreaterThanOrEqual(99)
```

`auditSurface(surface, context)` returns the violated rules plus `passed`, `failed`, and `undecided` node counts. `accessibilityScore(audits)` is the percentage of *decided* checks that passed; `formatViolations(audit)` renders one line per offending node, naming the rule, its impact, and the element.

### Render inside a landmark

Page-structure rules cannot be satisfied by a component floating in a bare `<body>`. Render each surface inside the landmark a real page provides — a `<main>` wrapper is enough — so the audit reports component defects rather than the harness's own missing page frame.

### Derive the audited set

A hand-written list of audited components silently stops covering the next one. Derive the set from the package's own exports and assert that the audited names equal the exported ones, so a new component or icon is audited the moment it ships.

### What can go wrong

- **Colour contrast reports as undecided** — jsdom computes no layout, so contrast checks decide nothing and count toward neither side of the score. A contrast regression needs the browser lane.
- **A portaled surface escapes the landmark** — content rendered into `document.body` sits outside the wrapper. Give it the role it actually has (a modal overlay is a `dialog`) instead of excluding the rule.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

The module is a thin, honest projection of `axe.run`. It fixes the tag list, requests violations, passes, and incomplete results, and converts axe's per-rule node arrays into counts. Incomplete results are reported separately and excluded from the score: scoring an undecided check either way would misstate the audit.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `CLIENT_AXE_TAGS`, `auditSurface`, `accessibilityScore`, `formatViolations` |
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

- **jsdom decides no colour contrast** — those checks return incomplete and are excluded from the score. Contrast is the browser lane's to prove.
- **One surface at a time** — the module audits a DOM subtree a caller already rendered. It mounts nothing and knows nothing about slots, so a suite decides what a surface is and how to build it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
