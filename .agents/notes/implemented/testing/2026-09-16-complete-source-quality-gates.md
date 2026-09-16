# Agent Note: Complete source quality gates

Status: implemented

English | [中文](2026-09-16-complete-source-quality-gates.zh.md)

## Problem

A coverage percentage cannot establish completeness when its configuration omits source files. A successful test run without instrumentation does not supply the missing measurements. Optional jobs and environment-controlled typechecking also prevent a green aggregate from proving that every required check succeeded.

## Decision

The coverage inventory discovers every JavaScript and TypeScript file under package source directories independently of Vitest configuration. The configuration validator requires the complete include pattern, an empty exclusion list, V8 measurement with automatic subprocess and worker-thread attachment, reports on failure, and unconditional per-file 100% thresholds for all four metrics. Measurement rejects missing file results and stale output, and preserves the same thresholds.

Every scheduled gate propagates failure. Typechecking has no environment bypass. Windows checks contribute to the required CI aggregate. Process-bound suites retain separate workers while participating in instrumented coverage. CI runs the complete suite in one coverage invocation. Process isolation remains necessary for suites that exercise process-global state and native lifecycle behavior; the [Windows record](../process/2026-08-08-native-windows-pull-request-ci.md) retains its platform ownership rationale.

The host TypeScript project includes snapshot drivers. Their imports participate in both typechecking and Vite's source-path resolution, so snapshot collection reaches the recorded-session assertions.

The syntax-aware source audit rejects lint, TypeScript, coverage and mutation disabling directives in comments and every catch clause. Its Git worktree inventory includes tracked and untracked JavaScript and TypeScript across packages, applications, scripts, snapshots, vendor, native, website, CI, and root configuration; new source directories also participate. Directive-like strings and regular expressions are data. This supersedes the directive permission in [mechanical quality gates](../process/2026-06-11-quality-gates.md). Explanatory comments do not alter the verdict. Parsing errors and empty source groups fail the audit.

This decision supersedes the archived [debt-marker policy](../../archived/testing/2026-09-06-coverage-debt-markers.md), [measurement policy](../../archived/testing/2026-09-12-coverage-debt-measurement.md), and [separate heavy-suite gate](../../archived/process/2026-07-31-coverage-exempt-heavy-suites.md). Those records describe removed policy, not current authority.

The optional partition coordinator, its command and report-merging path are removed. Each partial shard leaves other source files unexecuted and therefore fails the unchanged complete-source thresholds. A successful merged report cannot erase that failure. The [archived partitioning record](../../archived/process/2026-08-18-in-job-partitioned-coverage.md) preserves the retired mechanism; `scripts/coverage-command.ts` retains the shell-free measurement process, streamed output, bounded diagnostic tail, and independent exit, signal, and launch-error results.

Historical partition trials reported roughly 405 seconds for two Windows children, 112.66–122.01 seconds for sixteen Windows children, and 276.68 and 282.27 seconds for two Linux children. Larger in-process pools also produced worker exits, unreliable fixtures and Node 24 CJS-lexer failures. These earlier inventories and threshold policies cannot establish current performance or a passing complete-source result. Concurrency decisions require completed runs at a fixed configuration; slow progress alone does not justify restarting or increasing the process count.

## Alternatives considered

**Retain reason-bearing exclusions.** A documented omission still leaves behavior unmeasured. Recording its reason does not satisfy the required source coverage.

**Measure with reduced thresholds.** A measurement command must fail when evidence is incomplete. A separate permissive configuration would make its success ambiguous.

**Keep optional shards or workflow-level sharding.** Shards cannot satisfy complete-source thresholds independently. Workflow-level shards also repeat setup and require transferred reports and a merge dependency. Removing the coordinator preserves one coverage invocation without weakening any result.

**Keep platform failures advisory.** An aggregate must represent every required platform check; a successful Linux result cannot establish Windows behavior.

## Consequences

The strict gates expose outstanding violations and coverage gaps. Installing these checks does not resolve the findings or establish a repository-wide passing score. Repairs require behavior tests and measured results for the affected source; configuration validation alone supplies neither.
