# Agent Note: A TSX inline-color gate and illustration tokenization

Status: implemented

English | [中文](2026-09-01-tsx-inline-color-gate.zh.md)

## Problem

`.bao`/web-styling SSOT rules ban literal colors in product UI, and `client-ui-ssot` policed that — but its `token-bypass` detector read only `.css`, so every TSX `style={{ ... }}` prop and SVG `fill`/`stroke` attribute was an unpoliced bypass channel. The remaining violations lived exactly there: `katex.tsx` carried the KaTeX error red inline, and two drop-overlay illustrations plus a hero glow painted from raw hex attributes, which cannot participate in theme switching.

## Decision

`scripts/client-ui-ssot.ts` gained a `tsx-inline-color` detector: literal colors in TSX style objects (`color: 'rgb(204, 0, 0)'`, `fill: rgb(...)`) and literal-color SVG presentation attributes (`fill="rgb(57, 100, 254)"`) fail the scan outside the theme directory.

Live violations were fixed, not exempted:

- `ui-primitives/src/markdown/katex.tsx` — the error span's literal red moved to `.katex-error { color: var(--dsw-static-red-500) }` in `MarkdownText.module.css` (the class was already global there for `.katex-display`).
- `ui-attachment/src/DropOverlay.tsx` — the two SVG illustrations take fills from `DropOverlay.module.css` classes; the palette gained a static illustration band (`--dsw-static-illustration-{hero,teal,blue,card,amber}` in both `design-platform.css` theme blocks), reusing existing tokens (the hero blue `rgb(103, 158, 254)`→`deepseek-400`, the illustration blue `rgb(57, 100, 254)`→`blue-600`, the neutral grey `rgb(151, 157, 166)`→`neutral-bluish-500`).
- `ui-conversation/src/client/skeleton/EmptyHero.tsx` — the hero glow ellipse's periwinkle literal became `heroCss.heroGlowEllipse` (`--dsw-static-illustration-hero`) in `ConversationRoot.module.css`, next to the `.heroGlow` positioning class that consumes the component.

Detector proof lives in `scripts/client-ui-ssot.spec.ts`: one case per admitted form (style-object literal, SVG color attribute) plus negatives (className styling, `currentColor`, non-color geometry like `left`).

The detector is regex over TSX text, not an AST. Dynamic values (`fill={x}`) and CSS custom properties set via `setProperty` in TSX are out of scope — the latter is covered by the `--ds[wh]-` declaration index — and timing/geometry literals in style objects (`transition: 'transform 120ms ease'`) would need a separate detector with its own admitted-form proof.

## Alternatives considered

**Extend `token-bypass` to read TSX.** The finding kinds answer different questions — a CSS literal on a painted property versus a TSX object member or JSX attribute — and merging them would blur which rule and which fix applies. A distinct kind keeps the gate's messages actionable.

**Tokenize the SVGs into an assets pipeline instead.** The illustrations are inline JSX for layout coupling, not standalone assets; a pipeline would move them out of the components that size them. CSS Module classes keep them in place while the palette owns the color.

**Leave `currentColor`-style conventions to review.** The CSS Modules corpus was already gated; the audit showed the remaining channel was precisely the ungated one. A rule that stops at the `.css` boundary is a rule the next illustration circumvents.

## Consequences

TSX no longer bypasses the color SSOT, and illustration SVGs participate in dark/light theme switching where hex attributes could not. The gate costs a regex-shaped detector: it sees text, not syntax, so a genuinely dynamic color expression is invisible to it — the AST-level check would catch more and cost a TSX parser dependency in CI.
