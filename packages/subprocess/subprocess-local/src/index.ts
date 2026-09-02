/**
 * Local Service Provider for the subprocess capability seam. Each spawn is a detached
 * process tree with the spec's per-stream stdio dispositions. Normal disposal
 * terminates and joins live trees; Node's synchronous exit phase force-stops
 * any trees the service still owns. It has no config: every disposition and
 * limit arrives on the spec, so the deployment-varying choices stay with the
 * caller's config (the bash executor's, the LSP host's, …).
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as nodePty from 'node-pty'
import type { IPtyForkOptions } from 'node-pty'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { childEnv, spawnSubprocess } from './spawn.ts'
import type { LocalSubprocessHandle, SpawnInternals } from './spawn.ts'
import { createProcessInspector } from './process-inspector.ts'
import type { ProcessInspector } from './process-inspector.ts'
import { LocalTerminalHandle } from './terminal.ts'

/**
 * The extension list Windows treats as directly executable when a command
 * carries no extension of its own. Windows ships `.COM;.EXE;.BAT;.CMD;…`; this
 * fallback keeps the four every supported host defines when `PATHEXT` is absent
 * from the child environment.
 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Read the child environment's `PATHEXT` as a list, dropping the empty entries
 * a trailing or doubled `;` produces.
 * @param env - the child environment whose `PATHEXT` decides executability.
 * @returns the configured extensions, each including its leading dot.
 */
function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  return (environmentValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .filter(extension => extension.length > 0)
}

/**
 * Whether a Windows path names a file the operating system will start
 * directly. Windows carries no execute permission bit, so membership in
 * `PATHEXT` — the same rule {@link LocalSubprocessRuntime.executableCandidates}
 * applies when expanding a bare name — is what "executable" means there.
 * @param candidate - the candidate path, absolute or PATH-expanded.
 * @param extensions - the environment's `PATHEXT` entries, each with its leading dot.
 * @returns whether the candidate's extension is one of them.
 */
export function hasWindowsExecutableExtension(candidate: string, extensions: readonly string[]): boolean {
  const extension = extname(candidate).toLowerCase()
  if (extension.length === 0) return false
  return extensions.some(entry => entry.toLowerCase() === extension)
}

/**
 * Reject a candidate this host cannot start. POSIX asks the filesystem for the
 * execute bit; Windows has none — Node maps `X_OK` to `F_OK` there, so the
 * POSIX probe would accept every readable file, including an absolute
 * `notes.txt` — and the `PATHEXT` rule takes its place.
 * @param candidate - the existing regular file being considered.
 * @param env - the child environment supplying `PATHEXT` on Windows.
 * @throws when the candidate is not executable on this host.
 */
async function assertExecutable(candidate: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform !== 'win32') {
    await access(candidate, constants.X_OK)
    return
  }
  if (hasWindowsExecutableExtension(candidate, windowsExecutableExtensions(env))) return
  throw new Error(`subprocess-local: ${JSON.stringify(candidate)} is not one of the PATHEXT executable kinds`)
}

/**
 * Local subprocess service: detached process trees, Node-shaped stdio
 * dispositions (raw pipes, inherit, bounded tail-keep collection with spill
 * files), credential-scrubbed environment, and tree-scoped signalling with
 * SIGTERM→grace→SIGKILL escalation, plus synchronous final termination during
 * JavaScript-observable host exit.
 */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  /** Live handles retained for normal disposal and synchronous host-exit finalization. */
  private live = new Set<LocalSubprocessHandle>()
  /** Live terminals retained through normal quiescence or host-exit finalization. */
  private terminals = new Set<LocalTerminalHandle>()
  /** Test hook: spill and platform knobs forwarded to spawnSubprocess. */
  internals: SpawnInternals = {}
  /** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
  terminalInspector: ProcessInspector | undefined

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => {
      const onHostExit = (): void => { this.terminateForHostExit() }
      process.prependListener('exit', onHostExit)
      return async () => {
        try {
          await this.disposeManagedProcesses()
        } finally {
          process.off('exit', onHostExit)
        }
      }
    }, 'local subprocess teardown')
  }

  private terminateForHostExit(): void {
    for (const handle of this.live) {
      try {
        handle.terminateForHostExit()
      } catch (_ordinaryTreeTerminationFailed) {
        // Host exit cannot await or report one target; continue with the rest.
      }
    }
    for (const terminal of this.terminals) {
      try {
        terminal.terminateForHostExit()
      } catch (_terminalTerminationFailed) {
        // One terminal must not prevent final termination of another target.
      }
    }
  }

  private async disposeManagedProcesses(): Promise<void> {
    // Terminate (escalating), then await WHOLE-TREE exit — not just the
    // direct child's settlement — so even a TERM-trapping descendant cannot
    // outlive the fiber. Keep both sets authoritative while these waits are
    // pending so a shorter process-level exit bound can still force-kill them.
    const pending: Promise<unknown>[] = []
    for (const handle of this.live) {
      handle.terminate()
      // Spawn-failure rejections already settled and left the live set.
      pending.push(handle.done.catch(() => {}).then(() => handle.waitForExit()))
    }
    for (const terminal of this.terminals) {
      pending.push(terminal.terminate())
    }
    const outcomes = await Promise.allSettled(pending)
    const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
      ? [outcome.reason as unknown]
      : [])
    if (failures.length > 0) this.terminateForHostExit()
    this.live.clear()
    this.terminals.clear()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess teardown failed')
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-local: executable must be non-empty')
    signal?.throwIfAborted()
    const environment = childEnv(env)
    const absolute = isAbsolute(command)
    if (!absolute && (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))) {
      throw new Error(
        `subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const candidates = absolute ? [command] : this.executableCandidates(command, environment)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await assertExecutable(candidate, environment)
        signal?.throwIfAborted()
        return candidate
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted()
    throw new Error(absolute
      ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
      : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = environmentValue(env, 'PATH') ?? ''
    const extensions = process.platform === 'win32' && extname(command) === ''
      ? windowsExecutableExtensions(env)
      : ['']
    return path.split(delimiter).flatMap(directory =>
      extensions.map(extension => resolve(process.cwd(), directory, command + extension)))
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    // The warning sink is a default the test hook may replace: a contained
    // teardown failure belongs in the host's log, not in an unread return value.
    const handle = spawnSubprocess(spec, {
      warn: (message: string) => { this.ctx.logger.warn(message) },
      ...this.internals,
    })
    this.live.add(handle)
    // Release ownership only once the whole TREE is gone, not at direct-child
    // settlement — a TERM-trapping helper that outlives the leader must stay
    // owned so teardown can still escalate it. For the common no-survivor
    // case waitForExit resolves immediately after settlement.
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => { this.live.delete(handle) })
    handle.done.then(release, release)
    return handle
  }

  // Local PTY allocation is synchronous, but the provider contract permits remote asynchronous allocation.
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-local: terminal argv must contain a program')
    }
    spec.signal?.throwIfAborted()
    const options: IPtyForkOptions = {
      name: 'dumb',
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: childEnv(spec.env),
    }
    const inspector = this.terminalInspector ?? createProcessInspector()
    const terminal = nodePty.spawn(file, [...spec.argv.slice(1)], options)
    const handle = new LocalTerminalHandle(terminal, inspector, spec.graceMs)
    this.terminals.add(handle)
    const release = async (): Promise<void> => {
      await handle.terminate()
      this.terminals.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

/** Read a Windows environment key using the platform's case-insensitive semantics. */
function environmentValue(env: NodeJS.ProcessEnv, name: 'PATH' | 'PATHEXT'): string | undefined {
  const exact = env[name]
  if (exact !== undefined || process.platform !== 'win32') return exact
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}

export default LocalSubprocessRuntime
