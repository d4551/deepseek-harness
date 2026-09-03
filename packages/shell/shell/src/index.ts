/**
 * Service Definition for the `ctx.shell` capability seam, covering foreground commands and background process
 * handles, plus the model-facing result rendering and call contract both shell tool Consumers share. Job ids,
 * ownership, polling, and notices belong to `@deepseek-ai/dsh-jobs`, keeping executors independent of sessions.
 * The subprocess-backed implementation both dialect families extend lives on the `./subprocess-executor`
 * subpath, which imports this module.
 * @module @deepseek-ai/dsh-shell
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
} from './types.ts'
export { assertPositiveFinite, assertServiceableShellConfig, subprocessShellConfigFields } from './executor-config.ts'
export type { ResolvedSubprocessShellConfig, SubprocessShellConfig } from './executor-config.ts'
export { parseExitStatus, renderShellProcessRead, renderShellResult } from './render.ts'
export type { ParsedExitStatus, RenderableShellResult } from './render.ts'
export { processOutcome } from './background.ts'
export {
  SHELL_BACKGROUND_PARAMETER,
  SHELL_ESCALATION_GUIDANCE,
  SHELL_JUSTIFICATION_PARAMETER,
  SHELL_TIMEOUT_PARAMETER,
  SHELL_TOOL_OUTPUT_SCHEMA,
  SHELL_WORKDIR_PARAMETER,
  canonicalShellResult,
  shellEscalationParameter,
  validateShellToolArgs,
} from './tool-schema.ts'
export type { CanonicalShellResult, CanonicalShellStream, ShellToolArgs } from './tool-schema.ts'

/**
 * Settings namespace of this capability, owned here rather than by either
 * executor family because it names the capability, not an implementation: a
 * host composes exactly one provider of `ctx.shell` (the win32 layer swaps the
 * POSIX rows for the pwsh ones, and mounting both fails loud on a duplicate
 * service registration), so the providers share one namespace without ever
 * registering it twice, and a settings document carried between platforms
 * keeps resolving on both.
 */
export const SHELL_SETTINGS_NAMESPACE = settingsNamespace('shell')

/**
 * Exec-request fields an executor carries onto its spec verbatim, present only
 * when the caller stated them.
 */
export type CarriedShellFields = Pick<ShellExecSpec, 'signal' | 'stdin' | 'env' | 'dshEnv'>

/**
 * Carry the caller-stated pass-through fields of one exec request onto a spec.
 * An omitted field stays absent rather than becoming `undefined`, so the
 * subprocess service keeps ownership of the scrub and merge order.
 * @param request - exec request the executor is resolving.
 * @returns the stated pass-through fields, ready to spread into a spec.
 */
export function carriedShellFields(request: ShellExecRequest): CarriedShellFields {
  return {
    ...request.signal ? { signal: request.signal } : {},
    ...request.stdin !== undefined ? { stdin: request.stdin } : {},
    ...request.env !== undefined ? { env: request.env } : {},
    ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor
  }
}

/**
 * Abstract bash execution service. Subclass, implement the abstract methods,
 * and load the subclass as a plugin — it registers as `ctx.shell` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - {@link run} rejects only for infrastructure failures. Nonzero exits,
 *   timeout kills, and abort kills resolve with a {@link ShellRunResult}.
 * - {@link start} returns immediately; no timeout applies to background
 *   processes. `done` settles at process close and never rejects; spawn
 *   failures settle as `killed` with the error on stderr.
 * - {@link ShellProcess.readOutput} is incremental: consecutive reads never
 *   repeat output. Lossy reads report truncation and available spill files.
 * - A still-running background process is stopped and awaited when its
 *   owning composition tears down. With the subprocess seam that
 *   boundary is `ctx.subprocess` disposal, so a background process survives
 *   an executor-only reload.
 */
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  /**
   * The sandbox mode this executor applies by default, or `undefined` when it
   * does not sandbox commands.
   * @returns the configured default sandbox mode, when supported.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * Apply implementation-owned defaults and caps to a request before execution.
   * @param request - the caller's request; omitted fields get this
   *   implementation's defaults, capped fields are clamped.
   * @returns the fully-specified spec to hand to {@link run}/{@link start}.
   */
  abstract resolve(request: ShellExecRequest): ShellExecSpec

  /**
   * Run a command in the foreground; resolves when it finishes.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the outcome; nonzero exits, timeout kills, and abort kills
   *   resolve with a descriptive result rather than reject.
   */
  abstract run(spec: ShellExecSpec): Promise<ShellRunResult>

  /**
   * Start a background process and return its handle immediately.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the live process handle (reads, kill, quiescence promise).
   */
  abstract start(spec: ShellExecSpec): ShellProcess
}

export default ShellExecutor
