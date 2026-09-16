# Agent Note: In-job partitioned coverage

Status: implemented
Archived: 2026-09-16

English | [中文](2026-08-18-in-job-partitioned-coverage.zh.md)

## Problem

Native Windows coverage was the longest feedback path in the complete pull-request inventory. Keeping the instrumented suite in one single-worker Vitest process avoided the worker loss and Node 24 CJS lexer failures seen with larger in-process pools, but a failure could take more than fourteen minutes to appear and the gate runner withheld the child output until completion.

Partitioning must retain every test and preserve every failed result. Keeping its children inside one coverage job avoids repeated checkout, installation, artifact transfer, and an additional merge job.

## Decision

The coordinator remains an explicitly selected execution mode. The [complete-source quality gates](../testing/2026-09-16-complete-source-quality-gates.md) supersede this note's merged-only threshold ownership and default CI partition profile. Linux and native Windows CI run the complete suite in one instrumented Vitest invocation. `DSH_COVERAGE_MAX_WORKERS` gives that invocation its full worker budget; there is no separate uninstrumented gate.

When a caller sets `DSH_COVERAGE_PARTITIONS` to an integer greater than one, [the gate runner](../../../../scripts/run-gates.ts) selects the partitioned command. [The coordinator](../../../../scripts/coverage-partitions.ts) starts that many concurrent Vitest children, each with one worker, a distinct shard, its own coverage directory, and a blob report. Every child retains the configured reporters and per-file statement, branch, function, and line thresholds.

The coordinator waits for every child, validates that the blob directory contains exactly the expected files, and runs one merged coverage report. Each child and the merge must pass. A shard may leave source exercised by another shard uncovered; even a complete merged report cannot turn that child's failed threshold result into success. This makes partitioning unsuitable as the default complete-source coverage gate.

## Failure and output semantics

Partition children stream stdout and stderr through the coordinator. The coverage gate enables scheduler streaming so CI receives progress as it occurs. The coordinator retains a bounded 64 KiB combined tail per child and repeats it with the spawn error, exit code, or signal before validating the complete blob set.

A normal failed test can still emit a blob, allowing the merge to report coverage before the coordinator returns failure. Spawn failure, signal termination, non-zero exit, a missing or extra blob, and a failed merge all fail the gate. Cleanup unlinks a link-shaped coverage path without recursively following its target.

## Verification

The partition tests verify exact child and merge arguments, package-script separator removal, one-worker children, failed-test merging, failure diagnostics before blob validation, waiting for sibling processes after a spawn failure, and link-safe cleanup. The scheduler tests verify explicit partition selection, invalid-count rejection, the Windows build dependency, full worker-budget allocation, blocking results, and streamed output. The CI workflow test requires Linux and Windows coverage jobs to leave partition selection unset.

Historical native Windows comparisons measured two partitions near 405 seconds and sixteen partitions at 112.66–122.01 seconds; two Linux samples measured two partitions at 276.68 and 282.27 seconds. These measurements used the earlier coverage inventory and threshold policy. They do not establish performance or a passing result for complete-source coverage.

## Alternatives considered

**Workflow-level sharding.** Separate jobs repeat setup and require artifact transfers and a merge dependency. The coordinator keeps process isolation inside one job and workspace.

**More workers inside one instrumented process.** Historical Windows trials exposed worker exits, fixture instability, and Node 24 CJS lexer failures at higher fan-out. Separate single-worker children provided another isolation boundary; complete-suite CI still requires measurement under its current inventory.

**Merged-only thresholds.** The original design avoided judging a shard's partial execution independently. The complete-source quality-gate decision reverses that exception: a failed child remains a failed gate, including when its merged coverage passes.

## Consequences

Partitioning pays one Vitest startup per child and one report merge. Output can interleave, while partition labels and Vitest file identities identify its source. CI uses complete-suite coverage, and explicit partition runs may fail because independent shards do not cover the complete source inventory.

Concurrency tuning requires completed runs at a fixed configuration. Slow progress alone does not justify increasing process count or restarting a measurement.
