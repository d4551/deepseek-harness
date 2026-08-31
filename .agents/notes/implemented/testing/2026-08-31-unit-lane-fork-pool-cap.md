# Agent Note: Cap the unit-lane vitest fork pool

Status: implemented

English | [中文](2026-08-31-unit-lane-fork-pool-cap.zh.md)

## Problem

The unit lane ran an uncapped fork pool. Every worker is a full Node process that loads the workspace graph, and on a many-core host vitest spawned more of them than the machine could carry: an 18-core host ran 23 worker processes at once. The suites that themselves spawn processes — persistent Bash sessions, a language server over stdio, the Lefthook installer's real git invocations, Claude Code hook subprocesses — are the ones that lose the contention, so they time out or are killed while passing in isolation. Every other lane already bounds its workers.

## Decision

`vitest.config.ts` caps the fork pool at `Math.max(2, Math.min(availableParallelism(), 8))` on the root lane and on both projects, through `maxWorkers` (Vitest 4 removed `poolOptions`; its keys are ignored). Small hosts and CI runners stay effectively uncapped; only large ones bind. This matches what the sibling lanes already do: the expected-output lane caps at five workers, the coverage partitions run single-worker, and `run-gates.ts` computes its own ceiling.

## Alternatives considered

**Raise the per-test timeout on each suite that fails.** Rejected as the treatment for this: the timeouts are the symptom of a starved host, so the ceiling has to rise again on the next machine and the suites lose their real hang detection. A test whose own work legitimately exceeds the lane budget still deserves its own timeout.

**Cap only the process-bound project.** Rejected because the pressure is the sum of both lanes; the ordinary lane's workers are what leave the process-bound ones without a core.

**Let CI settle it.** Rejected because the local suite is the gate contributors run before pushing, and a suite that fails by machine size is not a signal anyone can act on.

## Consequences

The unit lane runs at most eight workers, so a large host finishes no faster than an eight-core one; that is the cost of a suite whose results do not depend on the machine. Process-spawning suites regain their contention headroom. A local run remains unreliable while another process mutates the same working tree — a concurrent `git checkout` invalidates the suites that assert branch and remote relationships, and no pool size fixes that.
