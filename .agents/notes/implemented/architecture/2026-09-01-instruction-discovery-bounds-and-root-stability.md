# Agent Note: Instruction discovery bounds and root stability

Status: implemented

English | [中文](2026-09-01-instruction-discovery-bounds-and-root-stability.zh.md)

## Problem

Three markers in `packages/context/agent-instructions` named three ways discovery could read the wrong thing, or too much of it.

`TODO(root-marker-unavailable)` sat in `existsAsMarker`. A provider `resolve`/`stat` that threw, and a host `stat` that failed for any reason, both returned `false` — the same answer as a marker that is genuinely not there. `findProjectRoot` treats `false` as "keep walking", so a directory the harness could not probe was walked straight past. When an ancestor carried a root marker, discovery adopted the ancestor project's root and every relative scope key was computed against it.

`TODO(frozen-project-root)` sat in reconciliation. The project root was recomputed from the session cwd on every pass. Scope keys are stored relative to that root, so adding or removing a root marker mid-session reinterpreted every key already recorded, and `workspaceBaselineIdentity` changed with it, replacing the baseline.

`TODO(total-instruction-read-bound)` sat in `readBounded`. `maxSourceBytes` caps one file. Nothing capped a batch, so a tree of individually small instruction files was read into memory without bound; `maxBytes` only trims what is rendered, after every accepted file has already been read.

## Decision

**A failed probe is not an absence.** `existsAsMarker` returns `'present' | 'absent' | 'unavailable'`. The provider branch reports `'unavailable'` when `resolve` or `stat` throws, and the host branch distinguishes `ENOENT` from every other errno. `findProjectRoot` returns the session directory on `'unavailable'`: a directory whose status is unknown is never walked past, so discovery cannot cross into an ancestor project on the strength of a failed probe. The safe answer is the same one an unmarked tree already produces.

**One session keeps one root.** The loop holds a `WeakMap<Session, string>` and resolves the project root once per session, passing it to reconciliation through the `projectRoot` option that already existed. Scope keys recorded under that root stay comparable for the session's life, and the baseline identity stops moving when a marker appears or disappears. Discovery inside `reconcileInstructionContext` remains as the fallback for callers that hold no retained root.

**A batch has an aggregate budget.** `SourceBudget` carries the bytes a batch may still read. `readBounded` caps each file at `Math.min(maxSourceBytes, budget.remaining)` and charges the accepted bytes, so the batch total is bounded even when every file fits its own cap. A baseline load opens one budget; a reconciliation batch opens one. The bound is the `maxTotalSourceBytes` config field, defaulting to eight times the per-file cap — far above real instruction sets, which run to kilobytes, while still bounding a pathological tree. It joins `workspaceBaselineIdentity` alongside `maxBytes` and `maxSourceBytes`, because it decides which files a baseline contains.

## Alternatives considered

**Throw on an unprobeable directory.** Loud, and wrong for this call: a marker probe walks upward through directories the session has no claim on, so a permission error above the workspace is expected rather than exceptional. Stopping the walk answers it without failing the turn.

**Recompute the root but migrate the scope keys.** Requires rewriting recorded keys under a new root and reconciling the two namings for entries already in the session log. Retaining the root avoids the migration entirely; a session that genuinely needs a new root is a new session.

**Derive the aggregate bound from `maxBytes`.** The render budget bounds what reaches the model, not what discovery reads, and dedup runs between them, so the two are not proportional. A separate field states the read bound directly and stays changeable from `cordis.yml`.

## Consequences

- A probe failure at or below the session directory yields the session directory as the project root instead of an ancestor's.
- A root marker created or deleted mid-session no longer moves the root, the scope keys, or the baseline identity.
- A batch stops accepting files once its aggregate budget is spent; files are charged in discovery order, so nearer-root files are read first.
- `maxTotalSourceBytes` appears in `Config`, in the generated config catalog, and in `workspaceBaselineIdentity`. The two session fixtures that pin that identity were refreshed keylessly.
- A non-positive or non-finite `maxTotalSourceBytes` disables loading, matching how `maxBytes` and `maxSourceBytes` already behave.

## Testing

`packages/context/agent-instructions/tests/agent-instructions.spec.ts` adds three groups. Probe outcomes: a merely absent marker still walks upward to the ancestor root, a provider `stat` failure stops at the session directory, and a host probe inside an unsearchable directory (`EACCES`, not `ENOENT`) does the same. Root retention: a nearer root marker appearing after the first pass leaves the baseline unreplaced and the outer scope present. Aggregate budget: a batch whose budget covers both files reads both, a budget covering one reads only the first, and a non-positive budget loads nothing. The probe and retention fixes were each reverted in place and the matching tests observed to fail before restoring; the retention test was sharpened after an initial version passed against the unfixed code.
