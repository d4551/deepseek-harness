# Agent Note: Markdown preview boundaries and readable trajectory tags

Status: implemented

English | [中文](2026-09-16-markdown-preview-boundaries.zh.md)

## Problem

Markdown footnotes can contain several paragraphs and code blocks. Treating their children as inline text joined adjacent words in trajectory previews. The message tag also rendered purple text at 3.69:1 contrast against its tinted background, below the 4.5:1 text requirement measured by native axe.

## Decision

The plain-text extractor uses the parser's `mdast.Nodes` contract and preserves footnote block separators before the trajectory consumer compacts whitespace. It shares the [incremental renderer's GFM grammar](../architecture/2026-08-06-web-markdown-incremental-ast-renderer.md); the parser and renderer retain their existing ownership.

The trajectory message tag uses the canonical primary-label foreground with its themed background. Cell padding, row gap, row radius, and border consume existing central tokens wherever their semantics match.

## Testing

The extractor's 26 real-parser tests reach 100% statements, branches, functions, and lines. Scoped Stryker mutation testing kills all 89 mutants in `plain-text.ts`, for 100%; this is an extractor result, not a repository score.

Four native Chromium cases exercise `trajectoryPreviewText` and the rendered cell at 640 and 1280 pixels in light and dark themes. They require separated footnote words, positive preview width, and zero axe violations or incomplete checks. These checks cover the tested preview surface, not every trajectory kind or application journey.

## Alternatives considered

**Flatten footnotes as inline content.** This discards paragraph boundaries before whitespace compaction can preserve word separation.

**Keep a permissive local AST shape.** Optional fields duplicate the parser's required-field contract and invite handling states the parser cannot produce.

**Retain the purple foreground mix.** Its measured contrast fails the text requirement; the primary-label token provides the theme's readable text color.

## Consequences

Preview words remain separated across footnote blocks. Message tags lose their purple foreground tint while keeping their themed background. Existing cell geometry and other tint formulas still lack matching canonical definitions; the token changes do not establish a complete design-system migration.
