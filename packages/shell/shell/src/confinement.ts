/**
 * The `ctx.sandbox` layer of a subprocess-backed shell executor: it wraps the
 * dialect's exact argv, converts positive runner-launch evidence into
 * `SANDBOX_UNAVAILABLE` (the command never ran), and stamps the mode,
 * enforcement, and denial facts the seam reports. Every dialect derives those
 * facts the same way, so one layer serves `@deepseek-ai/dsh-bash-sandbox` and
 * `@deepseek-ai/dsh-pwsh-sandbox` (see
 * [sandbox-classify](./sandbox-classify.ts) for the evidence rules themselves).
 * @module dsh-shell/confinement
 */

import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type {
  ConfinedArgv,
  ConfinedSandboxMode,
  RunnerFailureRule,
  SandboxEnforcement,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
  SandboxProvider,
} from '@deepseek-ai/dsh-sandbox'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from './sandbox-classify.ts'
import type { ShellExecSpec, ShellProcess, ShellRunResult } from './types.ts'

/**
 * What this layer reads from the deployment's policy service. Stating the two
 * members it uses keeps the seam free of a dependency on the policy package
 * while `ctx.sandboxPolicy` satisfies it structurally.
 */
export interface ShellSandboxPolicy {
  /** The deployment default mode — the capability fact the tool layer reads. */
  readonly defaultMode: SandboxMode
  /**
   * Resolve the standing deployment policy for a caller that stated none.
   * @returns the complete execution policy for an unattributed call.
   */
  resolve(): SandboxExecutionPolicy
}

/** What a confining executor gives this layer to reach its sandbox and policy. */
export interface ShellConfinementOptions {
  /** The `ctx.sandbox` provider that wraps each argv. */
  sandbox: SandboxProvider
  /** The deployment policy this executor falls back to. */
  policy: ShellSandboxPolicy
}

/** Per-process confinement facts retained until settlement. */
interface ProcessFacts {
  mode: ConfinedSandboxMode
  enforcement: SandboxEnforcement
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
  runnerProgram: string | undefined
  workdir: string
}

/**
 * Confinement state for one executor. Providers may vary enforcement and
 * diagnostic dialect between overlapping calls, so per-process facts are
 * retained until that process settles rather than shared as one latest-wrap
 * value; unconfined processes have no entry.
 */
export class ShellConfinement {
  private readonly options: ShellConfinementOptions
  private readonly processFacts = new Map<ShellProcess, ProcessFacts>()

  constructor(options: ShellConfinementOptions) {
    this.options = options
  }

  /** The configured default mode — the capability fact the tool layer reads. */
  get defaultMode(): SandboxMode {
    return this.options.policy.defaultMode
  }

  /**
   * The standing deployment policy, stamped onto a spec whose caller stated none.
   * @returns the resolved deployment-wide execution policy.
   */
  deploymentPolicy(): SandboxExecutionPolicy {
    return this.options.policy.resolve()
  }

  /**
   * Run one command confined, reporting the mode, enforcement, and denial facts.
   * @param spec - the resolved spec, carrying the complete per-call policy.
   * @param argv - the dialect's own argv for this spec.
   * @param runArgv - the executor's foreground launch of an exact argv.
   * @returns the settled run with its sandbox facts stamped.
   * @throws SandboxUnavailableError when the runner itself failed, so the command never ran.
   */
  async run(
    spec: ShellExecSpec,
    argv: readonly string[],
    runArgv: (argv: readonly string[]) => Promise<ShellRunResult>,
  ): Promise<ShellRunResult> {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') {
      const result = await runArgv(argv)
      return { ...result, sandbox: { mode, denied: false } }
    }
    const confined = this.confine(argv, { ...policy, mode })
    let result: ShellRunResult
    try {
      result = await runArgv(confined.argv)
    } catch (error) {
      // An upstream abort remains cancellation even when it prevents spawn.
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
    // Runner failure outranks denial because the command did not run. Carry
    // the matched fatal line, not an informational line that preceded it.
    const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules)
    if (runnerFailure !== undefined) {
      throw new SandboxUnavailableError(mode, runnerFailure.detail)
    }
    return { ...result, sandbox: { mode, denied: classifyDenial(result, confined.denialSignatures), enforcement: confined.enforcement } }
  }

  /**
   * Start one background command confined and retain its facts until settlement.
   * @param spec - the resolved spec, carrying the complete per-call policy.
   * @param argv - the dialect's own argv for this spec.
   * @param startArgv - the executor's background launch of an exact argv.
   * @returns the live process handle; {@link settle} stamps its sandbox facts.
   * @throws SandboxUnavailableError when a synchronous throw identifies the runner itself.
   */
  start(
    spec: ShellExecSpec,
    argv: readonly string[],
    startArgv: (argv: readonly string[]) => ShellProcess,
  ): ShellProcess {
    const policy = spec.sandboxPolicy as SandboxExecutionPolicy
    const { mode } = policy
    if (mode === 'danger-full-access') return startArgv(argv)
    // Once startArgv returns, install facts synchronously; promise settlement
    // cannot run before start() returns.
    const confined = this.confine(argv, { ...policy, mode })
    let proc: ShellProcess
    try {
      proc = startArgv(confined.argv)
    } catch (error) {
      // A subprocess runtime reports ENOENT/EACCES with the failed executable path through async
      // `done` rejection; this covers alternatives that throw the same error synchronously.
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) {
        throw new SandboxUnavailableError(mode, String(error))
      }
      throw error
    }
    const { enforcement, denialSignatures, runnerFailureRules } = confined
    this.processFacts.set(proc, {
      mode,
      enforcement,
      denialSignatures,
      runnerFailureRules,
      runnerProgram: confined.argv[0],
      workdir: spec.workdir,
    })
    return proc
  }

  /**
   * Stamp per-process sandbox facts before `done` settles. Full-access
   * processes have no facts; signal deaths are not denials.
   * @param proc - the settled process handle.
   * @param stderr - the process's retained stderr tail.
   * @param spawnFailed - whether the spawn rejected before any process existed.
   * @param spawnError - the spawn rejection, when `spawnFailed`.
   */
  settle(proc: ShellProcess, stderr: string, spawnFailed: boolean, spawnError?: unknown): void {
    const facts = this.processFacts.get(proc)
    if (facts === undefined) return
    this.processFacts.delete(proc)
    // A rejected spawn never started the confined launch. Otherwise runner
    // failure outranks denial because its diagnostics may contain denial terms.
    const runnerFailed = spawnFailed
      ? isRunnerSpawnFailure(spawnError, facts.runnerProgram, facts.workdir)
      : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
    proc.sandbox = {
      mode: facts.mode,
      denied: !runnerFailed && matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
      enforcement: facts.enforcement,
      ...(runnerFailed ? { runnerFailed } : {}),
    }
  }

  /** Wrap one dialect argv through the provider; provider errors propagate unchanged. */
  private confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    return this.options.sandbox.confine(argv, policy)
  }
}
