/**
 * Shared implementation of the `ctx.shell` Service Providers that run each
 * command as one managed `ctx.subprocess` process
 * (`@deepseek-ai/dsh-bash-local`, `@deepseek-ai/dsh-pwsh-local`, and their
 * confining subclasses). A provider supplies only its dialect: the argv it
 * spawns, the terminal environment that dialect understands, and the label its
 * diagnostics carry. Command defaulting, deadlines and cause classification,
 * output budgets, the model-facing background stdout/stderr merge, and
 * optional `ctx.sandbox` confinement are the same work for every dialect and
 * live here.
 * @module @deepseek-ai/dsh-shell/subprocess-executor
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { carriedShellFields, SHELL_SETTINGS_NAMESPACE, ShellExecutor } from './index.ts'
import { ShellConfinement } from './confinement.ts'
import type { ShellConfinementOptions } from './confinement.ts'
import { assertPositiveFinite, assertServiceableShellConfig } from './executor-config.ts'
import type { ResolvedSubprocessShellConfig, SubprocessShellConfig } from './executor-config.ts'
import type { CollectedOutput, ShellExecRequest, ShellExecSpec, ShellProcess, ShellProcessRead, ShellRunResult } from './types.ts'

/**
 * Abort reason code for this executor's own deadline. Every dialect reports the
 * same `timedOut` fact from one implementation, so one code classifies them
 * all; an outer deadline carries a different reason and stays an abort.
 */
const SHELL_TIMEOUT_CODE = 'BASH_TIMEOUT'

/** The dialect facts a provider fixes at construction. */
export interface ShellDialect {
  /** Diagnostic prefix naming the provider in its own errors, e.g. `bash-local`. */
  readonly label: string
  /**
   * Terminal environment entries merged FIRST into each spawn's explicit env,
   * so a trusted caller's own entry still wins and the subprocess service
   * applies its credential scrub independently. The set is dialect-specific: a
   * variable one shell honors can be meaningless in another.
   */
  readonly envOverrides: Readonly<Record<string, string>>
}

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

/**
 * Subprocess-backed shell executor. Bounded output, spill files, and
 * process-group kill escalation are the subprocess service's mechanics; this
 * executor supplies their configured budgets per spawn, so a still-running
 * background process stays managed (killed and joined at composition teardown)
 * even across an executor reload.
 *
 * A subclass supplies {@link argv} and calls {@link installShellSettings} once
 * the state it re-derives in {@link onConfigChange} exists; a confining
 * subclass additionally calls {@link confineThrough}.
 */
export abstract class SubprocessShellExecutor<C extends SubprocessShellConfig = SubprocessShellConfig> extends ShellExecutor {
  /** The currently authoritative config: the settings section, or the composition entry. */
  private source: () => ResolvedSubprocessShellConfig & C

  /** The sandbox layer, installed by a confining subclass; absent means this executor never confines. */
  private confinement: ShellConfinement | undefined

  /** The dialect this provider runs commands in. */
  protected readonly dialect: ShellDialect

  /** Validated config (schemastery applied the defaults before construction). */
  get config(): ResolvedSubprocessShellConfig & C {
    return this.source()
  }

  constructor(ctx: Context, config: C, dialect: ShellDialect) {
    super(ctx)
    // Schemastery fills these fields before construction; the type does not encode that step.
    const entry = config as ResolvedSubprocessShellConfig & C
    assertServiceableShellConfig(dialect.label, entry)
    this.dialect = dialect
    this.source = () => entry
  }

  /**
   * Register this provider's config as the shell settings section, so a stored
   * document layers over the composition entry.
   * @param schema - the provider's own `static Config` schema.
   * @param entry - the composition entry the stored section layers over.
   */
  protected installShellSettings(schema: z<C>, entry: C): void {
    installSettingsSection(this.ctx, SHELL_SETTINGS_NAMESPACE, schema, entry, {
      validate: (section) => { assertServiceableShellConfig(this.dialect.label, section) },
      setSource: (current) => {
        this.source = current as () => ResolvedSubprocessShellConfig & C
      },
      onChange: () => { this.onConfigChange() },
    })
  }

  /**
   * Re-derive whatever this provider computed from its config after the
   * settings document changed. Every field the shared executor reads goes
   * through {@link config} at each command, so the base implementation has
   * nothing to rebuild.
   */
  protected onConfigChange(): void {}

  /**
   * Route every command through `ctx.sandbox`. A confining subclass calls this
   * once at construction; without it the executor never confines and reports no
   * sandbox facts.
   * @param options - the sandbox provider plus this deployment's policy access.
   */
  protected confineThrough(options: ShellConfinementOptions): void {
    this.confinement = new ShellConfinement(options)
  }

  /** The default sandbox mode, present only for an executor that confines. */
  override get sandboxMode(): SandboxMode | undefined {
    return this.confinement?.defaultMode
  }

  /**
   * The exact argv that runs one resolved spec — this dialect's own invocation
   * (`bash -c <command>`, `pwsh … -Command <command>`), and the argv a
   * confining executor hands to `ctx.sandbox.confine`.
   * @param spec - the resolved spec whose command is being launched.
   * @returns the executable and arguments to spawn.
   */
  protected abstract argv(spec: ShellExecSpec): readonly string[]

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd` (else `process.cwd()`), and `timeoutMs` from
   * `config.timeoutMs`, capped at `config.maxTimeoutMs`. A confining executor
   * also stamps a complete per-call policy — tool calls supply the calling
   * session's resolved mode and root, lower-level callers fall back to the
   * deployment policy. The tool layer calls this before {@link run}/{@link
   * start}, so those methods receive explicit values and never re-default.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      `${this.dialect.label}: request.timeoutMs`,
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes
    assertPositiveFinite(this.dialect.label, 'request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes,
      ...carriedShellFields(request),
      // An executor that never confines carries a stated policy through
      // verbatim: the field is inert here by the seam contract.
      sandboxPolicy: this.confinement === undefined
        ? request.sandboxPolicy
        : request.sandboxPolicy ?? this.confinement.deploymentPolicy(),
    }
  }

  /** Map one resolved spec and its argv onto a fully-specified subprocess spawn. */
  // XXX(stateful-shell): evaluate persistent cwd or PTY sessions when workflows require shell state.
  private spawnSpec(
    spec: ShellExecSpec,
    argv: readonly string[],
    stdoutMaxBytes: number,
    signal: AbortSignal | undefined,
  ): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes } })
    return {
      argv: [...argv],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
      signal,
      // One explicit env map for the seam, layered so the trusted dshEnv
      // snapshot beats both the caller's env and the terminal overrides; the
      // subprocess service merges the whole map after its ambient scrub.
      env: { ...this.dialect.envOverrides, ...spec.env, ...spec.dshEnv },
    }
  }

  /** The collect-mode readers the executor itself requested (present by construction). */
  private collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdout === undefined || stderr === undefined) {
      throw new Error(`${this.dialect.label}: subprocess implementation dropped a requested collect stream`)
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const argv = this.argv(spec)
    const runArgv = (launched: readonly string[]): Promise<ShellRunResult> => this.runArgv(spec, launched)
    return this.confinement === undefined ? runArgv(argv) : this.confinement.run(spec, argv, runArgv)
  }

  /** Foreground run of an exact argv under this executor's deadline, environment, and output budgets. */
  private async runArgv(spec: ShellExecSpec, argv: readonly string[]): Promise<ShellRunResult> {
    // One deadline combines timeout and upstream cancellation; disposal clears its timer.
    using d = deadline(spec.signal, spec.timeoutMs, SHELL_TIMEOUT_CODE)
    const handle = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, spec.stdoutMaxBytes, d.signal))
    const outcome = await handle.done
    const collected = this.collected(handle)
    // Only this executor's timeout reason counts as timedOut; outer deadlines count as aborts.
    const timedOut = timeoutOf(d.signal, SHELL_TIMEOUT_CODE) !== undefined
    const aborted = d.signal.aborted && !timedOut
    return {
      ...outcome,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout: finalOutput(collected.stdout),
      stderr: finalOutput(collected.stderr),
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    const argv = this.argv(spec)
    const startArgv = (launched: readonly string[]): ShellProcess => this.startArgv(spec, launched)
    return this.confinement === undefined ? startArgv(argv) : this.confinement.start(spec, argv, startArgv)
  }

  /** Background start of an exact argv; callers stop it through `kill()` or `spec.signal`. */
  private startArgv(spec: ShellExecSpec, argv: readonly string[]): ShellProcess {
    // Background runs ignore timeoutMs; callers stop them through kill() or spec.signal.
    const running = this.ctx.subprocess.spawn(this.spawnSpec(spec, argv, this.config.maxOutputBytes, spec.signal))
    const collected = this.collected(running)

    // A spawn failure produces no process output, so the subprocess service has nothing
    // to buffer; the note is delivered exactly once through the read path.
    let spawnFailureNote: string | undefined
    const consumeSpawnFailure = (): string => {
      const note = spawnFailureNote ?? ''
      spawnFailureNote = undefined
      return note
    }

    let stdoutOffset = 0
    let stderrOffset = 0
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then((outcome) => {
        // Any signal termination is killed, including a command signaling itself.
        if (proc.status === 'running') {
          proc.status = spec.signal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        this.confinement?.settle(proc, collected.stderr.readFrom(0).text, false)
      }, (error: unknown) => {
        // Background spawn failures settle as killed and surface through the read path.
        proc.status = 'killed'
        spawnFailureNote = `spawn failed: ${String(error)}`
        this.confinement?.settle(proc, spawnFailureNote, true, error)
      }),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset

        // A failed spawn never produced process output, so the note and real
        // stderr text are mutually exclusive.
        const errText = err.text.length > 0 ? err.text : consumeSpawnFailure()
        // Single newline between sections: stdout chunks usually end with one
        // already; add it only when missing.
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running.terminate()
        return true
      },
    }
    return proc
  }
}
