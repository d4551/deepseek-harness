# Agent Note: Every workspace root reaches instructions and `@`-mentions

Status: implemented

English | [中文](2026-09-03-multi-root-instructions-and-file-references.zh.md)

## Problem

A session records its additional workspace roots in its own log, and consumers fold them on read ([`packages/core/session/src/workspace-roots.ts`](../../../../packages/core/session/src/workspace-roots.ts)). Search coverage, language-server routing, and sandbox policy each project that fold. Two consumers in `packages/context/` did not.

`agent-instructions` did project it — [`files.ts`](../../../../packages/context/agent-instructions/src/files.ts) walks a project chain for each additional root, and [`config.ts`](../../../../packages/context/agent-instructions/src/config.ts) folds the roots into the baseline identity so a session that gains or loses one rebuilds rather than keeps a baseline loaded from a different set of directories. Neither had a single test. `rg -ln additionalRoots packages/context/agent-instructions/tests/` returned nothing, the discovery loop and the identity field were the only uncovered lines in the package, and the CI per-file 100% coverage gate failed on both files. Untested model-visible discovery is the case that matters: the loop decides what instruction text a multi-root session sends to the model.

`file-reference-local` did not project it at all. `LocalFileReferenceService.list` built its index from `agent.session.header.cwd` alone, so in a multi-root session the user could not `@`-reference a file in an additional root. The index also never noticed a root set the client changed mid-session, because it was cached per agent with no key.

## Decision

**The instruction loop is pinned by behavior, not by a coverage exemption.** `packages/context/agent-instructions/tests/agent-instructions.spec.ts` gains an `additional workspace root instruction discovery` suite that asserts what a multi-root session sends: each additional root contributes its own project chain after the primary one, displayed absolute; each chain stops at that root's own marker rather than an enclosing project; a root with no instruction file contributes nothing; a repeated root loads once; a file the primary chain already loaded keeps its project-relative display path; recorded order decides section order; and the rendered baseline carries the additional root's text with the primary chain first. Three cases drive the plugin end to end — recording a root mid-session appends a replacement baseline under a new identity, re-recording the same set appends nothing, and a log that names the primary root among its roots produces byte-identical text and identity to one that does not.

**File-reference search covers every root, following the `tool-fs-search` precedent rather than the `tool-lsp` one.** `searchRoots` ([`packages/fs/tool-fs-search/src/search-core.ts`](../../../../packages/fs/tool-fs-search/src/search-core.ts)) names every root because ripgrep answers one query from all of them; `sessionWorkspaceRoot` ([`packages/lsp/tool-lsp/src/session-cwd.ts`](../../../../packages/lsp/tool-lsp/src/session-cwd.ts)) routes each file to its deepest containing root because the language-server seam takes exactly one root per query. `@`-completion is the first kind: one query returns a ranked list, and the user must be able to reach any root's files from it. So `WorkspaceFileSearch` takes `readonly string[]` roots and covers all of them; `LocalFileReferenceService` resolves them with `sessionWorkspaceRoots`, falling back to the host process directory only when the session records neither a cwd nor a root.

Per-file routing still falls out for free, without a routing step: an absolute directory query resolves inside exactly the root that contains it and yields nothing for the others, because `resolveDisplayDirectory` already rejects a path outside its root. That is what makes drilling into an additional root work after its absolute candidate is selected.

**Mention text is root-relative for the primary root and absolute for the others.** A root-relative path from a second checkout would collide with a same-named file in the first, and the model-facing guidance states that `@` paths are relative to the workspace root. Absolute is the same answer `agent-instructions` gives an additional root's instruction display path and the same one `toWorkdirRelative` leaves for a non-workdir search hit.

**Ranking scores the path inside its own root.** Scoring the display path would let a root's own location decide matches — every candidate under `/home/me/checkouts/service/` would match a query for `checkouts`, and `visibleForGlobalQuery` would hide a whole root whose absolute path contains a dotted segment. Each indexed entry therefore carries a `sortPath` (root-relative) beside its display candidate, and the comparator ends with the root's position so two roots holding the same path rank primary-first.

**One traversal, breadth-first across roots.** The scan queue is seeded with every root, so `maxEntries` is spent on every root's shallow paths before any root's deep ones; a deep primary root cannot starve a later one, which is the failure the fix exists to prevent. A path two roots both reach is indexed once, under whichever root's traversal reached it first. Any root that cannot be read fails the whole traversal, extending the existing rule that an unreadable root must not publish a partial index over entries that are still good.

**The index is keyed by the root set it was built for.** `list` compares the session's current roots against the cached set and retires the index when they differ, which is what "consumers fold on read" means for a cache.

## Verification

`bun x vitest run packages/context` — 11 files, 295 tests, all passing (268 before this change).

`bun x vitest run packages/context --coverage --coverage.include='packages/context/**/src/**/*.ts'` — 100% statements, branches, functions, and lines, per-file thresholds enforced. Before: `files.ts` 96.66% (348-353 uncovered), `config.ts` 92.30% (93 uncovered), `index.ts` missing the `additionalRoots` filter callback.

`bun x tsx scripts/run-oxlint.ts packages/context` — clean.

Each new assertion was proved load-bearing by mutation. Deleting the per-additional-root loop in `files.ts` failed 7 of the 11 instruction cases; the 4 survivors are the ones that pin dedup and identity stability, which are true with an empty root set as well. Dropping `additionalRoots` from `workspaceBaselineIdentity` failed exactly the mid-session case, which is the only case that can observe it. Reducing `completionRoots` to the session cwd failed all 3 service cases. Scoring the display path instead of `sortPath` failed the root-prefix case and the nested-root case. Every file was restored and the suite is green.

Coverage of `search.ts` also removed a `v8 ignore` on `compareText`: with one root its zero branch was unreachable, and with two roots holding the same path it is the branch that hands the tie to the root order.

## Alternatives considered

**Route `@`-completion to one root per query, like `tool-lsp`.** Rejected: the seam returns a list, not a single answer, and the user has no way to name which root they mean before they have seen a candidate. Routing would reproduce the hole for the bare fuzzy query, which is the common case.

**Concatenate per-root result pages instead of re-ranking across roots.** Rejected: with the primary root's page first, a perfect match in a second root falls below weak primary matches and off the end of `maxResults`. That is a narrower version of the same defect. Merging per-root pages and re-ranking is exact, not approximate — a candidate in the global top-k is necessarily in its own root's top-k.

**Keep `WorkspaceFileSearch` single-root and add a composite that fans out.** Rejected: the composite would need the private scores to merge correctly, so ranking would have to be exported anyway, and two objects would own one invalidation counter and one entry budget. One class with a root list keeps the budget, the staleness counter, and the traversal in one owner.

**Prefix additional-root candidates with the root's basename instead of its absolute path.** Rejected: basenames collide (two checkouts of the same repository), and the result is not a path `read` can open.

**Traverse each root to completion in turn, so a nested root's files render primary-relative.** Rejected: it hands the whole entry budget to the first root. Losing the nicer display for a root nested inside another is a cosmetic cost; starving a root of the budget is the defect being fixed.

**Suppress the coverage failure with an exclusion or a `v8 ignore`.** Rejected outright: the uncovered lines are the feature. An exemption would record that a model-visible discovery path is untested and make the gate agree with it.

## Consequences

A multi-root session now loads instructions from every root and can `@`-reference files in every root. Adding or removing a root mid-session costs one replacement baseline — the whole instruction prefix after that point, by design, because the previous baseline described a different set of directories.

`WorkspaceFileSearch`'s constructor takes `readonly string[]`; `file-reference-local` depends on `@deepseek-ai/dsh-session` for the fold. Single-root sessions are byte-identical to before: one root means `rootIndex` is always 0, so display, ranking, and traversal order are unchanged, and no recorded session snapshot moves.

`maxEntries` bounds the whole index rather than each root, so many or large roots reach the cap sooner, and one unreadable root discards the whole rebuild rather than publishing the remaining roots. Both are stated under Known Limitations in the package README.

## Related

- [Instruction discovery bounds and root stability](2026-09-01-instruction-discovery-bounds-and-root-stability.md) — the byte budgets and per-session project-root memoization this discovery runs inside.
