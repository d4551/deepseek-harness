# Agent Note: A gate for the suppression rules the repository already states

Status: implemented

English | [中文](2026-09-01-suppression-justification-gate.zh.md)

## Problem

`AGENTS.md` states two rules about suppressed checks: a linter exception is narrow and justified, and an empty `catch` names what it swallows and why nothing else can reach it. Nothing executed either one. A census of the 250 shipped package source trees found the rules were in fact honored — 121 lint directives and 89 empty catches, every one with a reason — but only after reading each site by hand, which is not a standard a reviewer can apply and not a state a later change preserves.

## Decision

`scripts/suppression-justifications.spec.ts` runs the scan in `scripts/suppression-justifications.ts` over `packages/*/*/src`, and fails on a lint directive or empty `catch` that states no reason. A reason counts when it follows the rule name after `--`, or when a comment sits above the run — a `-next-line` run alternates directives with the single line each annotates, and the walk upward steps over both. A `catch` holding any statement handles the failure and is not the scan's business.

The scan proves its own rejections: a bare directive, a bare `catch {}`, an inline reason, a grouped reason, and a handling `catch` are each a case, so the live tree is a second corpus rather than the only one.

Three sites moved to satisfy it. `region.ts` dropped two assertions that `indexOf` had already made redundant — `nodes[startIdx]` is the `start` seq the caller passed — and stated why each surviving index is in range. `testing.ts` gained the reason its sibling in `schema.ts` already carried. `token-meter` moved its explanation from above the setup line to above the directive it explains.

## Alternatives considered

**Teach the scan to find a reason separated from its directive by code.** That is what `token-meter` had, and widening the walk to reach it would accept any comment loosely near a suppression. Moving the comment to the line it explains is the smaller change and the one a reader benefits from.

**Enforce it in oxlint instead.** The rule spans two unrelated constructs — a directive comment and an empty block — and the empty-`catch` half is about prose, not about the rule being suppressed. A repository gate reads both without a custom linter plugin.

**Record the census and leave the rules ungated.** The census was clean, which is exactly when a gate is cheap to add and never has to be retrofitted against a backlog.

## Consequences

A suppression added without a reason fails `bun run test`. The scan is textual, so a reason written far from its directive reads as absent — which is the standard it enforces rather than a limitation of it.
