/**
 * Config vocabulary shared by the `ctx.shell` Service Providers that run each
 * command as one managed subprocess: the knobs they accept, the shipped
 * defaults their `static Config` literals apply, and the serviceability rules
 * the schema cannot express.
 * @module dsh-shell/executor-config
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config; matches OpenCode's 3s). */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap (the `maxSpillBytes` config). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Execution knobs every subprocess-backed shell provider accepts (all optional — the schema supplies defaults). */
export interface SubprocessShellConfig {
  /** Default working directory for commands (default: process.cwd()). */
  cwd?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes?: number
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes?: number
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults (`cwd` has none). */
export type ResolvedSubprocessShellConfig =
  & Required<Omit<SubprocessShellConfig, 'cwd'>>
  & Pick<SubprocessShellConfig, 'cwd'>

/**
 * Fresh field schemas for the knobs the shared executor reads, carrying this
 * executor family's shipped defaults. A provider names each field in its own
 * `static Config` literal — [`gen-config-catalog`](../../../../scripts/gen-config-catalog.ts)
 * walks those keys statically — and takes the schema behind each name from
 * here, so no default is written twice. Each call returns new schemas, keeping
 * one provider's field out of another's.
 * @returns the shared config fields, one schema per accepted knob.
 */
export function subprocessShellConfigFields(): {
  cwd: z<string>
  timeoutMs: z<number>
  maxTimeoutMs: z<number>
  maxOutputBytes: z<number>
  maxSpillBytes: z<number>
  graceMs: z<number>
} {
  return {
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64_000),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES),
    graceMs: z.number().default(DEFAULT_GRACE_MS),
  }
}

/**
 * Reject a byte or millisecond budget no execution could use.
 * @param label - the provider's diagnostic prefix, e.g. `bash-local`.
 * @param name - the field being checked, as the caller names it.
 * @param value - the stated value.
 * @throws Error naming the field that cannot be used.
 */
export function assertPositiveFinite(label: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label}: ${name} must be a positive finite number`)
  }
}

/**
 * Reject a resolved section a subprocess-backed provider could not run with.
 * The schema expresses neither "positive and finite" nor the timer bound
 * `graceMs` has to fit, so a stored value is refused where it is written
 * instead of failing at the next command.
 * @param label - the provider's diagnostic prefix, e.g. `bash-local`.
 * @param config - the resolved section, schema-valid by construction.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceableShellConfig(label: string, config: SubprocessShellConfig): void {
  const resolved = config as ResolvedSubprocessShellConfig
  assertPositiveFinite(label, 'timeoutMs', resolved.timeoutMs)
  assertPositiveFinite(label, 'maxTimeoutMs', resolved.maxTimeoutMs)
  assertPositiveFinite(label, 'maxOutputBytes', resolved.maxOutputBytes)
  assertPositiveFinite(label, 'maxSpillBytes', resolved.maxSpillBytes)
  assertPositiveFinite(label, 'graceMs', resolved.graceMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${label}: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
