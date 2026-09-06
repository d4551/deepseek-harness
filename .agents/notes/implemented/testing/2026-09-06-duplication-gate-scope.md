# Agent Note: The duplication gate covers every authored TypeScript tree

Status: implemented

English | [中文](2026-09-06-duplication-gate-scope.zh.md)

## Problem

`bun run duplication` ran jscpd over `packages scripts` and reported no clones. Two trees it never read hold authored TypeScript: `apps/` and `website/`. Running the same configuration over them found three clones — one in `scripts/client-ui-ssot.ts` where two motion rules asked the same guard question, one edit-link pattern written twice in `website/.vitepress/config.ts` under two locale labels, and two adjacent `pairedPages` calls in `website/docs.ts` with an identical mapping body.

The gate's silence therefore said "no clones in the two directories I read", while reading as "no clones".

## Decision

The script names every authored TypeScript tree: `jscpd --config .jscpd.json packages scripts apps website`. The three clones are removed rather than excused — a shared `unansweredSelectors` helper, a named `editSourceUrl` function both locales link through, and one merged `pairedPages` call. The tree is at zero clones across 1930 files under the same `minTokens: 60` / `minLines: 6` settings, which stay unchanged: this widens what the gate reads, it does not relax what it rejects.

`.jscpd.json` still carries `"ignore": ["**/tests/**"]`. That exclusion is measured rather than assumed: running with tests included reports 1877 clones over 3321 files, 2.74% of lines. Most are parallel arrange blocks that say what a case sets up, but the set also holds byte-identical helpers that belong in `packages/test-support/*` — two `assemble.ts` files differing in one string literal, and three copies of a 14-line `test-session-query.ts`. Closing that is a separate change with its own ratchet; recording the number here keeps the exclusion from reading as "there is nothing there".

## Alternatives considered

**Drop the tests exclusion now and set a percentage threshold at the measured 2.74%.** Rejected for this change: a ceiling is only honest once someone has triaged what sits under it, and 1877 clones have not been. A threshold chosen to fit the current tree, before that triage, is the shape of number this repository treats as a softening.

**Leave `apps/` and `website/` out because they are not shipped packages.** Rejected: both are authored TypeScript a contributor edits, and `website/docs.ts` is where the projection's page tables live — exactly the kind of table that gets copied.

## Consequences

A clone introduced in `apps/` or `website/` now fails the gate the same way one in `packages/` does. The tests exclusion remains, with its cost written down: 1877 clones, 2.74% of lines, measured on this tree.
