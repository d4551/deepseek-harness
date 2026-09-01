# Agent Note: Mutation-tier coverage repair for browser-locale and diagnostic-text

Status: implemented

English | [中文](2026-09-01-mutation-tier-browser-locale-coverage.zh.md)

## Problem

`bun run mutation` failed locally at 96.88 against the 99 floor. The report showed two honest gaps, not equivalent mutants: `packages/util/browser-locale` and `packages/util/diagnostic-text` shipped no `tests/invariant.spec.ts`, unlike every other package in the mutation tier, so their `invariant.ts` companions produced `NoCoverage` mutants; and `browser-locale`'s `resolveBrowserLocale` window path — the `typeof window` read of `navigator.languages` plus the `navigator.language` fallback — had no test at all, because only the tags-override and no-window paths were exercised. The tier's ratchet only holds if every package in `mutate` has its tests in `vitest.mutation.config.ts`'s include, so adding a package to the tier without its companion spec silently drags the floor. CI's recorded 99.08 predated the drift, which is why the local run is what caught it.

## Decision

Both packages carry the missing companion spec, in the same shape as `atomic-write/tests/invariant.spec.ts`. `browser-locale.spec.ts` covers the window path with `vi.stubGlobal` cases torn down by `vi.unstubAllGlobals()`: no-window proves `navigator` is unread (a stubbed `zh` still yields `en`), and the remaining cases pin the preference-ordered read and the `languages`-only and `language`-only embedder shapes.

`resolveBrowserLocale`'s fallback reads `languages ?? [language]` rather than appending `navigator.language` after the `languages` list, which is what the documented contract already said — `language` backs the whole list when `languages` is absent — and the append was redundant when both report the same leading tag. The no-window `[]` array literal carries a `Stryker disable next-line ArrayDeclaration` comment: any junk replacement holds no `zh` tag, so the returned locale cannot change, while the branch itself stays pinned by the no-window test. The file scores 100/17, and the remaining tier survivors are the seven equivalents already recorded in `stryker.config.mjs`.

`stryker.config.mjs` also lists `.audit-tmp` in `ignorePatterns`. Stryker's sandbox copier died with `ENOTSUP` copying a socket inside `.audit-tmp/bun-cache`, a non-source residue directory like the already-ignored `coverage` and `dist-exe`. No mutation or test scope changed.

## Alternatives considered

**Record the `NoCoverage` mutants as equivalents in `stryker.config.mjs`.** That list exists for mutants no test can distinguish. These were reachable behavior with no test, so recording them would have spent the equivalence list on a coverage gap and left the ratchet describing something other than what is tested.

**Keep appending `navigator.language` after the `languages` list.** It is redundant whenever both report the same leading tag, and the documented contract already makes `language` the whole-list fallback rather than a trailing entry, so the append was a second rule for a case the first rule covers.

**Leave the no-window `[]` literal mutable and let the survivor stand.** It would have held the tier below its floor for a mutant whose replacements cannot change the returned locale; the disable comment is scoped to that one literal and the branch keeps its own test.

## Consequences

Every package in the mutation tier now has an `invariant.ts` companion spec, so a package joining the tier without one is a visible omission rather than a silent floor drop. `browser-locale` has one fallback rule instead of two.
