# Agent Note: TS7 syntax-duplication gate replaces the dropped sonarjs rules

Status: implemented

English | [中文](2026-08-31-syntax-duplication-gate.zh.md)

## Problem

Dropping `eslint-plugin-sonarjs` ([the TS7-only lint decision](../process/2026-08-30-manual-same-major-dependency-bump.md) era; commit `5cc29d5ce0`) handed three of its eight rules to survivors — `no-dupe-else-if`, `typescript/no-duplicate-type-constituents`, and the jscpd `duplication` gate — and silently retired the other five: duplicate character-class members, all-branches-identical chains, duplicated multi-statement branches, identical short-circuit operands, and duplicate test titles. No installable replacement exists: the plugin hard-requires the TypeScript 6 API at module load, and the audited alternatives are not in the tree.

## Decision

[scripts/syntax-duplication.ts](../../../../scripts/syntax-duplication.ts) reimplements exactly the five retired checks on the TypeScript 7 parser (`typescript/unstable/ast`, batched through the shared [ts7-session](../../../../scripts/ts7-session.ts) the same way the Strada-import sweep batches). [scripts/syntax-duplication.spec.ts](../../../../scripts/syntax-duplication.spec.ts) is the gate: a red/green contract per rule, then a `git ls-files` sweep asserting the tracked tree is clean, in the same executed-lane form as `typescript7-unstable-api.spec.ts`.

Calibration matches the replaced rules, not a stricter invention:

- **Single-statement branches are exempt** from `duplicated-branch` (S1871's documented exception — `case a: return x` mapping tables are idiomatic); the all-identical check still owns the fully degenerate chain (S3923), including switches.
- **`.each` template titles carrying `$`/`%` placeholders register no static title** — they expand per table row — but a `describe.each` body still opens its own title scope.
- **Escape sequences tokenize whole** (`\u{…}`, `￿`, `\xFF`, `\cX`, `\p{…}`): the first sweep flagged 221 false duplicates by splitting `\uXXXX` into glyphs.
- **Short-circuit operands only** (`&&`, `||`, `??`): arithmetic self-pairing (`x * x`) is legitimate, and `x === x` stays with oxlint `no-self-compare`.

Function-body clones remain jscpd's. The live sweep found zero genuine findings — consistent with the tree having been sonarjs-clean two days before.

## Companion fix

The same audit round reverted the `838c5e7328` relaxation in [tool-bash integration](../../../../packages/shell/tool-bash/tests/integration.spec.ts): accepting `'absent' | 'present'` for the lazy-JSONL probe un-proved the laziness the test is named for. The harness now pins `writeBatchMaxDelayMs` past the turn so the write-behind deadline cannot fire mid-test, and the strict single-string `absent` assertion is back — the race was made deterministic instead of tolerated.
