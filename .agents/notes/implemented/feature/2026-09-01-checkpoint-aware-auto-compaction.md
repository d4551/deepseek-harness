# Agent Note: Checkpoint-aware auto-compaction with a hysteresis watermark

Status: implemented

English | [中文](2026-09-01-checkpoint-aware-auto-compaction.zh.md)

## Problem

Auto-compaction was head-anchored with a single trigger: every pressure pass shadowed the surface head — including the previous checkpoint — and stopped the moment pressure dipped below the threshold. Three costs followed. First, each pass re-read and re-merged the entire prior checkpoint, so the summarizer input grew toward the context window even when only a small span of new content needed condensing. Second, stopping just under the threshold meant the next step crossed it again: one pressure crossing produced a compaction on nearly every subsequent step. Third, a summary that failed to shrink its span aborted the whole pressure pass, and the next step retried the same failing call forever.

## Decision

### Pressure passes compact toward a hysteresis watermark

`BasicCompactionConfig` gains `targetRatio` (default `0.85`). `resolveCompactSpec` scales it into `targetTokens = floor(thresholdTokens × targetRatio)`. A pressure pass keeps condensing while pressure remains at or above the watermark, bounded by `compactionRetries`, and returns once below it; if the attempts exhaust with pressure still at or above the threshold, the pass throws the convergence error as before. A landing therefore sits well below the trigger, and the next trigger needs fresh growth instead of one step.

Retention must stay below the watermark: a ratio retention at or above `thresholdRatio × targetRatio` fails at load, and an absolute `retainTokens` at or above `targetTokens` fails on first use, mirroring the existing threshold validations.

### Range selection is checkpoint-aware

`selectCompactableRange` returns a discriminated plan: a `range` carrying its strategy, or a `none` naming the reason (`empty`, `all-retained`, `unbalanced`, or `checkpoint-only` — a consolidation span that would shadow nothing but one lone checkpoint). After the retention and balance walks, the strategy resolves by counting leading compaction-checkpoint nodes on the surface:

- **Zero leading checkpoints** — consolidate from the head, as before.
- **One leading checkpoint** — skip it and shadow only the newer span, when that span reaches `MIN_SKIP_SPAN_ROUTE_TOKENS` (512); otherwise consolidate, because a smaller span would likely fail the shrink comparison and waste a model call.
- **Two or more leading checkpoints** — consolidate from the head, so the surface never accumulates a chain of summaries; the next crossing merges them back into one.

Later passes of one pressure pass always consolidate, so a skip pass that does not relieve pressure enough is followed by a merge pass. Overflow recovery keeps forcing one maximal head consolidation, unchanged.

### Shrink failures retry as consolidation

The shrink comparison throws a typed `SummaryShrinkError`. The pressure loop treats it as a per-pass failure, logs it, and continues with the next (consolidating) pass; when every pass fails to shrink, the last shrink error is rethrown. Explicit `compactRegion` callers still see it as an ordinary failure. A pass can therefore no longer wedge into repeating the same failing call every step.

### The transaction moves to promise-boundary result handling

The bracket-first region transaction keeps its event sequence and crash contract — one `compaction/start`, exactly one `compaction/end` attempt, a failed close leaving a blocking orphan — but no longer uses `try/catch`. The post-start phase runs inside one async runner whose throws settle as rejections, and the caller reads the settled outcome with typed result checks before making the close attempt. The `region.ts` monolith is split into `selection.ts` (span selection, pricing snapshot, stability checks), `transaction.ts` (the transaction), `lock.ts` (entry state and lock assertions), `auto.ts` (automatic listeners), `manual.ts` (idle-admission entry point), `target.ts` (routed-target resolution), and `schema.ts` (loader schemas), all under the 400-line ceiling.

## Alternatives considered

- **Keep single-checkpoint head anchoring** — rejected: every pass re-reads the whole checkpoint, and the checkpoint grows without bound while newer content stays cheap to condense separately.
- **Compaction to a fixed absolute target** — rejected: ratios already scale across models in this backend; a ratio watermark reuses the existing policy machinery.
- **Fail the whole pass on a non-shrinking summary** — the previous behavior; rejected because the same failing call retried every step.
- **Protect the failing request's driving user message during overflow recovery** — rejected: the failing request reconstructs from the whole surface, and protecting its leading message would defeat recovery for runaway tool turns whose bulk sits after it; the existing newest-pair retention already keeps the request's final units verbatim.

## Consequences

- Up to two checkpoints can coexist on an automatic surface between crossings; the next pressure crossing consolidates them. Manual mid-range compaction may still leave more.
- `compactIfNeeded` logs each successful replacement with its strategy (`skip-checkpoint` or `consolidate`) and warns with the selection reason when pressure remains but no span exists.
- `selectCompactableRange` no longer returns `null`; callers switch on `kind` and read `reason` for diagnostics.
- The `compaction/summary` and replacement events, the durable lock, and `CompactionResult` are unchanged; only selection policy, the retry loop, and module layout changed.

## Testing

`compaction-selection.spec.ts` covers watermark resolution and both retention validations, skip/consolidate/floor selection including a two-checkpoint merge, the in-band continuation toward the watermark, shrink-failure consolidation and final shrink-error rethrow, and the reason-carrying warning. The legacy `compaction-basic.spec.ts` was split into `compaction-config`, `compaction-pressure`, `compaction-region`, `compaction-summarizer`, `compaction-auto-pressure`, `compaction-auto-recovery`, and `compaction-image` specs sharing `tests/harness.ts`, with the existing expectations updated to the watermark call counts. The loop, manual, and loader suites are unchanged and stay green.
