/**
 * LiteRT-LM lifecycle: model import into the `litert-lm` registry, the
 * `litert-lm serve` process, and the startup health wait against
 * `GET /v1/models`.
 *
 * Everything here is the part the OpenAI-compatible wire protocol cannot
 * supply — the process and the model files. Requests themselves never reach
 * this module; they go to the pi-ai `openai-completions` route the plugin
 * registers against {@link LitertServer}'s endpoint.
 *
 * @module dsh-llm-litert/server
 */

import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { LitertModelConfig, ResolvedLitertServerConfig } from './config.ts'

/** Timeout code carried by an elapsed `litert-lm` budget. */
export const LITERT_TIMEOUT_CODE = 'LITERT_TIMEOUT'

/** Start one managed child process; the plugin passes `ctx.subprocess.spawn`. */
export type LitertSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** Resolve the `litert-lm` executable; the plugin passes `ctx.subprocess.resolveExecutable`. */
export type LitertExecutableResolver = (
  command: string,
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<string>

/**
 * Ask one already-started server whether it serves yet.
 * @param url - the server's `GET /v1/models` address.
 * @param signal - aborts the probe when startup gives up.
 * @returns `true` once the server answered that request successfully.
 */
export type LitertHealthProbe = (url: string, signal: AbortSignal) => Promise<boolean>

/** The three collaborators {@link LitertServer} owns no implementation of. */
export interface LitertServerCollaborators {
  /** Executable lookup in the subprocess provider's execution world. */
  resolveExecutable: LitertExecutableResolver
  /** Managed child-process start. */
  spawn: LitertSpawner
  /** Startup readiness probe against `GET /v1/models`. */
  probe: LitertHealthProbe
}

/** Everything one supervised LiteRT-LM server needs to reach a serving state. */
export interface LitertServerSpec {
  /** Fully defaulted supervision settings. */
  readonly server: ResolvedLitertServerConfig
  /** The endpoint the route is registered against; the probe appends `/models`. */
  readonly baseURL: string
  /** Models that must exist in the registry before the server starts. */
  readonly models: readonly LitertModelConfig[]
}

/** A settled `litert-lm` run: its exit facts and both retained output tails. */
interface CompletedRun {
  /** Exit code; `null` when a signal killed the process. */
  readonly exitCode: number | null
  /** Terminating signal; `null` on a normal exit. */
  readonly signal: NodeJS.Signals | null
  /** Retained stdout tail. */
  readonly stdout: string
  /** Retained stderr tail. */
  readonly stderr: string
}

/**
 * Probe one endpoint with an ordinary HTTP GET. A non-2xx answer still proves
 * the listener is up, but only a successful `GET /v1/models` proves the model
 * registry loaded, which is what the caller waits for.
 * @param url - the `GET /v1/models` address.
 * @param signal - aborts the request when startup gives up.
 * @returns `true` when the server answered with a 2xx status.
 */
export const httpHealthProbe: LitertHealthProbe = async (url, signal) => {
  const response = await fetch(url, { method: 'GET', signal })
  return response.ok
}

/**
 * Sleep for one health-probe interval, or until the startup budget elapses.
 * @param ms - the configured interval.
 * @param signal - the startup deadline's signal.
 * @returns a promise resolving at the interval or as soon as the signal aborts.
 */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Render one settled run for a failure message without letting the tail run away. */
function outputDetail(run: CompletedRun): string {
  const stderr = run.stderr.trim()
  const stdout = run.stdout.trim()
  const detail = stderr.length > 0 ? stderr : stdout
  return detail.length > 0 ? `: ${detail}` : ''
}

/** Render one settled run's exit facts. */
function exitDetail(run: CompletedRun): string {
  return run.signal === null ? `exit code ${String(run.exitCode)}` : `signal ${run.signal}`
}

/**
 * Render one rejection reason for a diagnostic. The probe is caller-supplied,
 * so its rejection carries no type this package can rely on.
 * @param reason - the value the probe rejected with.
 * @returns text naming the reason.
 */
function failureText(reason: unknown): string {
  return reason instanceof Error ? reason.message : JSON.stringify(reason)
}

/**
 * One supervised `litert-lm serve` process and the model imports it depends
 * on. {@link start} is the whole readiness path — import, spawn, health wait —
 * and {@link dispose} is its only teardown; both are idempotent enough for the
 * plugin's effect disposer to run after a failed start.
 */
export class LitertServer {
  private handle: SubprocessHandle | undefined
  private executable: string | undefined

  /**
   * @param spec - the supervision settings, endpoint, and required models.
   * @param collaborators - executable lookup, process start, and health probe.
   */
  constructor(
    private readonly spec: LitertServerSpec,
    private readonly collaborators: LitertServerCollaborators,
  ) {}

  /**
   * Bring the server to a serving state: resolve the executable, import every
   * configured model the registry does not already hold, start
   * `litert-lm serve`, and wait for it to answer `GET /v1/models`.
   * @param signal - cancels startup; the caller's plugin disposal passes its own.
   * @throws Error naming the step that failed, with the child's retained output.
   */
  async start(signal: AbortSignal): Promise<void> {
    const { server } = this.spec
    this.executable = await this.collaborators.resolveExecutable(server.command, server.env, signal)
    await this.importMissingModels(signal)
    signal.throwIfAborted()
    const handle = this.collaborators.spawn(this.spawnSpec([
      'serve',
      '--host', server.host,
      '--port', String(server.port),
    ], signal))
    this.handle = handle
    await this.awaitHealthy(handle, signal)
  }

  /**
   * Terminate the server process and wait for its tree to exit. Safe to call
   * when {@link start} never spawned anything.
   */
  async dispose(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    if (handle === undefined) return
    handle.terminate()
    await handle.waitForExit()
  }

  /**
   * Import every configured model the `litert-lm` registry does not already
   * hold. A model already in the registry is never re-imported, so a restart
   * against a warm model volume does not re-download gigabytes.
   */
  private async importMissingModels(signal: AbortSignal): Promise<void> {
    const present = await this.registryIds(signal)
    for (const model of this.spec.models) {
      if (present.has(model.id)) continue
      signal.throwIfAborted()
      await this.importModel(model, signal)
    }
  }

  /**
   * Read the ids `litert-lm list` reports. The command prints one row per
   * registered model with the id in the leading column; its header row cannot
   * collide with a real id, because an id that matched it would only skip an
   * import the server then fails on, loudly.
   */
  private async registryIds(signal: AbortSignal): Promise<ReadonlySet<string>> {
    const run = await this.run(['list'], this.spec.server.importTimeoutMs, signal)
    if (run.exitCode !== 0) {
      throw new Error(
        `llm-litert: "${this.spec.server.command} list" failed with ${exitDetail(run)}${outputDetail(run)}`,
      )
    }
    const ids = new Set<string>()
    for (const line of run.stdout.split('\n')) {
      const id = line.trim().split(/\s+/, 1)[0]
      if (id !== undefined && id.length > 0) ids.add(id)
    }
    return ids
  }

  /** Import one model, naming the repository and the file the failure came from. */
  private async importModel(model: LitertModelConfig, signal: AbortSignal): Promise<void> {
    const argv = [
      'import',
      ...model.huggingFaceRepo === undefined ? [] : ['--from-huggingface-repo', model.huggingFaceRepo],
      model.file,
      model.id,
    ]
    const run = await this.run(argv, this.spec.server.importTimeoutMs, signal)
    if (run.exitCode !== 0) {
      const source = model.huggingFaceRepo === undefined
        ? model.file
        : `${model.huggingFaceRepo}/${model.file}`
      throw new Error(
        `llm-litert: importing model ${JSON.stringify(model.id)} from ${source} failed with`
        + ` ${exitDetail(run)}${outputDetail(run)}`,
      )
    }
  }

  /**
   * Poll `GET /v1/models` until the server answers, the startup budget
   * elapses, or the process exits first — whichever comes first names the
   * failure. A wait that does not end in a serving process leaves no process
   * behind.
   */
  private async awaitHealthy(handle: SubprocessHandle, signal: AbortSignal): Promise<void> {
    const { server } = this.spec
    const url = `${this.spec.baseURL}/models`
    let exit: CompletedRun | undefined
    let startFailure: unknown
    void handle.done.then(
      (outcome) => { exit = { ...outcome, ...this.collectedOutput(handle) } },
      (failure: unknown) => { startFailure = failure },
    )
    using budget = deadline(signal, server.startupTimeoutMs, LITERT_TIMEOUT_CODE)
    let lastProbeFailure: unknown
    while (!budget.signal.aborted) {
      if (startFailure !== undefined) {
        throw new Error(`llm-litert: ${server.command} serve could not be started`, { cause: startFailure })
      }
      if (exit !== undefined) {
        throw new Error(
          `llm-litert: ${server.command} serve exited during startup with ${exitDetail(exit)}${outputDetail(exit)}`,
        )
      }
      // A probe failure is the ordinary state while a server is still loading
      // its model, so it advances the loop; the last one is quoted only if the
      // budget then elapses, which is where the wait actually fails.
      const healthy = await this.collaborators.probe(url, budget.signal)
        .then(answer => answer, (failure: unknown) => {
          lastProbeFailure = failure
          return false
        })
      if (healthy) return
      await pause(server.healthIntervalMs, budget.signal)
    }
    await this.dispose()
    const cause = timeoutOf(budget.signal, LITERT_TIMEOUT_CODE)
    if (cause === undefined) {
      throw new Error(`llm-litert: ${server.command} serve startup was cancelled`, { cause: budget.signal.reason })
    }
    const detail = lastProbeFailure === undefined ? '' : `; last probe failed: ${failureText(lastProbeFailure)}`
    throw new Error(
      `llm-litert: ${server.command} serve did not answer GET ${url} within`
      + ` ${server.startupTimeoutMs}ms${detail}`,
      { cause },
    )
  }

  /** Run one short `litert-lm` subcommand to completion under its own budget. */
  private async run(
    argv: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CompletedRun> {
    using budget = deadline(signal, timeoutMs, LITERT_TIMEOUT_CODE)
    const handle = this.collaborators.spawn(this.spawnSpec(argv, budget.signal))
    const outcome = await handle.done.then(settled => settled, (failure: unknown) => {
      throw new Error(
        `llm-litert: ${this.spec.server.command} ${argv[0] ?? ''} could not be started`,
        { cause: failure },
      )
    })
    const collected = this.collectedOutput(handle)
    const cause = timeoutOf(budget.signal, LITERT_TIMEOUT_CODE)
    if (cause !== undefined) {
      throw new Error(
        `llm-litert: ${this.spec.server.command} ${argv[0] ?? ''} exceeded ${timeoutMs}ms`
        + outputDetail({ ...outcome, ...collected }),
        { cause },
      )
    }
    return { ...outcome, ...collected }
  }

  /** Read both retained output tails of one settled child. */
  private collectedOutput(handle: SubprocessHandle): { stdout: string; stderr: string } {
    return {
      stdout: handle.collected.stdout?.readFrom(0).text ?? '',
      stderr: handle.collected.stderr?.readFrom(0).text ?? '',
    }
  }

  /** One fully specified spawn for a `litert-lm` child; the seam applies no defaults. */
  private spawnSpec(argv: readonly string[], signal: AbortSignal): SubprocessSpawnSpec {
    const { server } = this.spec
    /* v8 ignore next -- start() resolves the executable before any spawn. */
    const command = this.executable ?? server.command
    return {
      argv: [command, ...argv],
      cwd: server.cwd,
      stdio: {
        stdin: 'ignore',
        // Both tails are bounded diagnostics: `list` is parsed from stdout and
        // every failure quotes whichever tail carries the reason. No spill —
        // the retained tail is what the failure message can hold.
        stdout: { maxBytes: server.maxStderrBytes },
        stderr: { maxBytes: server.maxStderrBytes },
      },
      graceMs: server.shutdownGraceMs,
      signal,
      env: server.env,
    }
  }
}
