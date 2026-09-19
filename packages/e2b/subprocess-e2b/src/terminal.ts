/** E2B PTY allocation and process-session ownership for the subprocess seam. */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { posix } from 'node:path'
import {
  CommandExitError,
  e2bControlEnvs,
  FileNotFoundError,
  SandboxNotFoundError,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import type { CommandHandle, CommandResult, Sandbox } from '@deepseek-ai/dsh-e2b'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type E2BRuntime from '@deepseek-ai/dsh-e2b'
import {
  bootstrapEnvironment,
  readRemoteEnvironment,
  serializeRemoteEnvironment,
} from './environment.ts'
import { asError, commandOpts, delay, signalOpts, signalRemoteGroups } from './remote.ts'

/** Values a Promise reject arm may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

function ignoreRejection(_reason: Thrown): undefined {
  return undefined
}

const TERMINAL_RUNNER_SOURCE = [
  '#!/bin/bash',
  'set -euo pipefail',
  'dsh_state=$1',
  'mapfile -d \'\' -t dsh_env < "$dsh_state/environment"',
  'mapfile -d \'\' -t dsh_argv < "$dsh_state/argv"',
  'dsh_output_marker=$(<"$dsh_state/output-marker")',
  'rm -f -- "$dsh_state/environment" "$dsh_state/argv" "$dsh_state/output-marker" "$dsh_state/runner.bash"',
  'if (( ${#dsh_argv[@]} == 0 )); then',
  "  printf 'terminal runner received empty argv\\n' >&2",
  '  exit 125',
  'fi',
  'printf \'%s\' "$dsh_output_marker"',
  'exec env -i -- "${dsh_env[@]}" "${dsh_argv[@]}"',
  '',
].join('\n')

interface TerminalPaths {
  runner: string
  environment: string
  argv: string
  outputMarker: string
}

class BootstrapOutputFilter {
  readonly ready: Promise<void>

  private readonly readyState = Promise.withResolvers<void>()
  private pending = Buffer.alloc(0)
  private published = false

  constructor(
    private readonly marker: Buffer,
    private readonly output: PassThrough,
  ) {
    this.ready = this.readyState.promise
  }

  push(data: Uint8Array): void {
    if (this.published) {
      this.write(data)
      return
    }
    const combined = Buffer.concat([this.pending, Buffer.from(data)])
    const markerOffset = combined.indexOf(this.marker)
    if (markerOffset < 0) {
      const retained = Math.min(combined.length, this.marker.length - 1)
      this.pending = Buffer.from(combined.subarray(combined.length - retained))
      return
    }
    this.published = true
    this.pending = Buffer.alloc(0)
    this.readyState.resolve()
    this.write(combined.subarray(markerOffset + this.marker.length))
  }

  private write(data: Uint8Array): void {
    if (data.length > 0 && !this.output.destroyed) this.output.write(data)
  }
}

async function waitForBootstrapOutput(
  ready: Promise<void>,
  completion: Promise<CommandResult>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  // Whichever settles first wins: the boundary, an early exit, or the caller's abort.
  const exitedEarly = (_reason?: Thrown): never => {
    throw new Error('subprocess-e2b: terminal exited before publishing its output boundary')
  }
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => { aborted.reject(asError(signal?.reason)) }
  signal?.addEventListener('abort', onAbort, { once: true })
  const detach = (): void => { signal?.removeEventListener('abort', onAbort) }
  await Promise.race([ready, completion.then(exitedEarly, exitedEarly), aborted.promise]).finally(detach)
}

function parsePositiveId(value: string, message: string): number {
  const raw = value.trim()
  const id = Number(raw)
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) throw new Error(message)
  return id
}

function serializeValues(values: readonly string[], kind: string): string {
  for (const value of values) {
    if (value.includes('\0')) throw new Error(`subprocess-e2b: terminal ${kind} must not contain NUL bytes`)
  }
  return values.map(value => `${value}\0`).join('')
}

async function terminalSessionId(
  sandbox: Sandbox,
  pid: number,
  envs: Record<string, string>,
  signal?: AbortSignal,
): Promise<number> {
  const result = await sandbox.commands.run(`ps -o sid= -p ${pid}`, commandOpts(envs, signal))
  signal?.throwIfAborted()
  return parsePositiveId(result.stdout, `subprocess-e2b: cannot resolve process session for terminal ${pid}`)
}

function sessionProcessGroups(
  sandbox: Sandbox,
  sessionId: number,
  envs: Record<string, string>,
): Promise<number[]> {
  return sandbox.commands.run(
    `set -o pipefail; ps -eo sid=,pgid=,stat= | awk '$1 == ${sessionId} && $3 !~ /^[ZXx]/ { print $2 }'`,
    commandOpts(envs),
  ).then(
    (result) => {
      const groups = new Set<number>()
      for (const raw of result.stdout.trim().split(/\s+/)) {
        if (raw.length === 0) continue
        const group = parsePositiveId(
          raw,
          `subprocess-e2b: invalid process group ${JSON.stringify(raw)} in terminal session ${sessionId}`,
        )
        if (group <= 1) {
          throw new Error(`subprocess-e2b: unsafe process group ${group} in terminal session ${sessionId}`)
        }
        groups.add(group)
      }
      return [...groups]
    },
    (error: Thrown) => {
      if (error instanceof SandboxNotFoundError) return []
      throw error
    },
  )
}

async function awaitSessionEmpty(
  sandbox: Sandbox,
  sessionId: number,
  envs: Record<string, string>,
  graceMs: number,
  pollMs: number,
  kill = false,
): Promise<number[]> {
  const deadline = Date.now() + graceMs
  for (;;) {
    const groups = await sessionProcessGroups(sandbox, sessionId, envs)
    if (groups.length === 0) return groups
    if (kill) {
      await signalRemoteGroups(sandbox, envs, groups, 'KILL')
      if (Date.now() >= deadline) return await sessionProcessGroups(sandbox, sessionId, envs)
    } else if (Date.now() >= deadline) {
      return groups
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

function rollbackUnpublishedTerminal(
  sandbox: Sandbox,
  handle: CommandHandle,
  completion: Promise<CommandResult>,
  envs: Record<string, string>,
  graceMs: number,
  pollMs: number,
): Promise<void> {
  let topLevelExited = false
  completion.then(
    () => { topLevelExited = true },
    (_reason: Thrown) => { topLevelExited = true },
  )
  const hasTopLevelExited = (): boolean => topLevelExited
  const validPid = Number.isSafeInteger(handle.pid) && handle.pid > 1
  const attemptFailures: Error[] = []
  let sessionId: number | undefined
  const proveAndDisconnect = (): Promise<void> => {
    const proofFailures: Error[] = []
    const finish = (): Promise<void> => {
      if (!hasTopLevelExited()) {
        proofFailures.push(new Error(`subprocess-e2b: terminal setup rollback failed; surviving pid: ${handle.pid}`))
      }
      if (proofFailures.length > 0) {
        throw new AggregateError(
          [...attemptFailures, ...proofFailures],
          'subprocess-e2b: terminal setup rollback did not reach quiescence',
        )
      }
      return handle.disconnect().then(
        () => undefined,
        (error: Thrown) => {
          if (!(error instanceof SandboxNotFoundError)) throw error
        },
      )
    }
    if (sessionId === undefined) return finish()
    return awaitSessionEmpty(sandbox, sessionId, envs, graceMs, pollMs, true).then(
      (groups) => {
        if (groups.length > 0) {
          proofFailures.push(new Error(
            `subprocess-e2b: terminal setup rollback failed; surviving process groups: ${groups.join(', ')}`,
          ))
        }
        return finish()
      },
      (error: Thrown) => {
        proofFailures.push(asError(error))
        return finish()
      },
    )
  }
  const waitThenProve = (): Promise<void> =>
    Promise.race([completion.then(undefined, ignoreRejection), delay(graceMs)]).then(proveAndDisconnect)
  const killTopLevelIfNeeded = (): Promise<void> => {
    if (hasTopLevelExited()) return proveAndDisconnect()
    return handle.kill().then(
      waitThenProve,
      (error: Thrown) => {
        if (error instanceof SandboxNotFoundError) return
        attemptFailures.push(asError(error))
        return waitThenProve()
      },
    )
  }
  if (!validPid) return killTopLevelIfNeeded()
  sessionId = handle.pid
  const recordAttempt = (error: Thrown): void => {
    attemptFailures.push(asError(error))
  }
  return terminalSessionId(sandbox, handle.pid, envs).then(
    (id) => {
      sessionId = id
      return id
    },
    (_sessionLookupFailure: Thrown) => {
      // E2B's PTY leader is also the provisional POSIX session leader, so its
      // PID remains usable after the setup lookup itself fails or is canceled.
      return handle.pid
    },
  ).then(id => sessionProcessGroups(sandbox, id, envs).then(
    (initial) => {
      if (initial.length === 0) return
      return signalRemoteGroups(sandbox, envs, initial, 'TERM').then(
        () => awaitSessionEmpty(sandbox, id, envs, graceMs, pollMs).then(
          (groups) => {
            if (groups.length === 0) return
            return awaitSessionEmpty(sandbox, id, envs, graceMs, pollMs, true).then(
              () => undefined,
              recordAttempt,
            )
          },
          recordAttempt,
        ),
        recordAttempt,
      )
    },
    recordAttempt,
  )).then(killTopLevelIfNeeded)
}

/** One E2B PTY and all process groups in its remote process session. */
export class E2BTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly done: Promise<SubprocessOutcome>

  private topLevelExited = false
  private cleanup: Promise<void> | undefined
  private readonly operationController = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private terminationSignal: NodeJS.Signals | null = null

  constructor(
    private readonly sandbox: Sandbox,
    private readonly handle: CommandHandle,
    readonly output: PassThrough,
    private readonly completion: Promise<CommandResult>,
    private readonly sessionId: number,
    private readonly controlEnvs: Record<string, string>,
    private readonly stateDir: string,
    private readonly graceMs: number,
    private readonly pollMs: number,
  ) {
    this.pid = handle.pid
    this.done = this.waitForCommand()
  }

  // TODO(e2b-pgid-identity): Replace retained numeric PTY/session ids when E2B
  // exposes identity-bound input, foreground-signal, and cleanup operations.
  /** @inheritdoc */
  write(data: string): Promise<void> {
    return this.trackOperation(async (signal) => {
      if (this.topLevelExited) throw new Error('terminal process has exited')
      await this.sandbox.pty.sendInput(this.pid, Buffer.from(data, 'utf8'), { signal })
    })
  }

  /** @inheritdoc */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return this.trackOperation(signal => this.inspectForegroundOnce(signal))
  }

  /** @inheritdoc */
  signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    return this.trackOperation(async (operationSignal) => {
      const foreground = await this.inspectForegroundOnce(operationSignal)
      if (foreground === undefined) {
        throw new Error(`subprocess-e2b: cannot resolve foreground process group for terminal ${this.pid}`)
      }
      if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
        throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
      }
      await this.sandbox.commands.run(
        `kill -${signal.slice(3)} -- -${foreground.processGroupId}`,
        commandOpts(this.controlEnvs, operationSignal),
      )
      return foreground.processGroupId
    })
  }

  /** @inheritdoc */
  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.operationController.abort(new Error('subprocess-e2b: terminal is terminating'))
    const cleanup = this.closeAfterOperations()
    this.cleanup = cleanup
    cleanup.then(undefined, (_cleanupFailure: Thrown) => {
      this.cleanup = undefined
    })
    return cleanup
  }

  private async inspectForegroundOnce(
    signal: AbortSignal,
  ): Promise<SubprocessTerminalForeground | undefined> {
    return this.sandbox.commands.run(
      `ps -o tpgid= -p ${this.pid}`,
      commandOpts(this.controlEnvs, signal),
    ).then(
      result => ({
        processGroupId: parsePositiveId(
          result.stdout,
          `subprocess-e2b: cannot resolve foreground process group for terminal ${this.pid}`,
        ),
        // E2B exposes process-table commands but not the /proc memory access
        // needed to prove a specific syscall is waiting on fd 0.
        inputWaiting: false,
      }),
      (error: Thrown) => {
        if (error instanceof CommandExitError && (error.exitCode === 1 || this.topLevelExited)) return undefined
        throw error
      },
    )
  }

  private trackOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operationController.signal.aborted) {
      return Promise.reject(new Error('subprocess-e2b: terminal is terminating'))
    }
    const pending = operation(this.operationController.signal)
    this.operations.add(pending)
    pending.then(
      () => { this.operations.delete(pending) },
      (_reason: Thrown) => { this.operations.delete(pending) },
    )
    return pending
  }

  private async closeAfterOperations(): Promise<void> {
    await Promise.allSettled(this.operations)
    await this.closeOnce()
  }

  private waitForCommand(): Promise<SubprocessOutcome> {
    return this.completion.then(
      result => ({ exitCode: result.exitCode, signal: null }),
      (error: Thrown) => {
        if (error instanceof CommandExitError) {
          return this.terminationSignal === null
            ? { exitCode: error.exitCode, signal: null }
            : { exitCode: null, signal: this.terminationSignal }
        }
        this.output.destroy(asError(error))
        throw error
      },
    ).finally(() => {
      this.topLevelExited = true
      if (!this.output.destroyed) this.output.end()
    })
  }

  private closeOnce(): Promise<void> {
    const ignoreDone = (): Promise<unknown> =>
      Promise.race([this.done.then(undefined, ignoreRejection), delay(this.graceMs)])
    const disconnectAndRemove = (): Promise<void> =>
      this.handle.disconnect().then(
        () => undefined,
        (error: Thrown) => {
          if (!(error instanceof SandboxNotFoundError)) throw error
        },
      ).then(() => this.sandbox.files.remove(this.stateDir).then(
        () => undefined,
        (_adapterPrivateStateRemovalFailure: Thrown) => undefined,
      ))
    const prove = (groups: number[]): Promise<void> => {
      if (groups.length > 0) {
        throw new Error(`subprocess-e2b: terminal cleanup failed; surviving process groups: ${groups.join(', ')}`)
      }
      if (!this.topLevelExited) {
        throw new Error(`subprocess-e2b: terminal cleanup failed; surviving pid: ${this.pid}`)
      }
      return disconnectAndRemove()
    }
    const afterForce = (groups: number[]): Promise<void> => {
      if (!this.topLevelExited) return ignoreDone().then(() => prove(groups))
      return prove(groups)
    }
    const force = (): Promise<void> => {
      this.terminationSignal = 'SIGKILL'
      const emptied = (): Promise<void> =>
        awaitSessionEmpty(this.sandbox, this.sessionId, this.controlEnvs, this.graceMs, this.pollMs, true).then(afterForce)
      if (this.topLevelExited) return emptied()
      return this.handle.kill().then(
        emptied,
        (error: Thrown) => {
          if (error instanceof SandboxNotFoundError) return
          throw error
        },
      )
    }
    const afterTerm = (remaining: number[]): Promise<void> => {
      const continueClose = (): Promise<void> => {
        if (remaining.length > 0 || !this.topLevelExited) return force()
        return prove(remaining)
      }
      if (remaining.length === 0 && !this.topLevelExited) return ignoreDone().then(continueClose)
      return continueClose()
    }
    return sessionProcessGroups(this.sandbox, this.sessionId, this.controlEnvs).then((groups) => {
      if (groups.length > 0) {
        this.terminationSignal = 'SIGTERM'
        return signalRemoteGroups(this.sandbox, this.controlEnvs, groups, 'TERM').then(
          () => awaitSessionEmpty(this.sandbox, this.sessionId, this.controlEnvs, this.graceMs, this.pollMs).then(afterTerm),
        )
      }
      return afterTerm(groups)
    })
  }
}

/**
 * Allocate an E2B PTY, replace its bootstrap shell with the requested argv,
 * and return only after the private runner has published readiness.
 * @param runtime - Shared E2B sandbox owner.
 * @param spec - Fully specified terminal-process request.
 * @param stateDir - Private remote directory for one startup transaction.
 * @param pollMs - Remote session liveness poll cadence.
 * @returns The live subprocess terminal handle.
 */
export async function spawnE2BTerminal(
  runtime: E2BRuntime,
  spec: SubprocessTerminalSpawnSpec,
  stateDir: string,
  pollMs: number,
): Promise<E2BTerminalHandle> {
  const sandbox = await runtime.getSandbox()
  spec.signal?.throwIfAborted()
  const paths: TerminalPaths = {
    runner: posix.join(stateDir, 'runner.bash'),
    environment: posix.join(stateDir, 'environment'),
    argv: posix.join(stateDir, 'argv'),
    outputMarker: posix.join(stateDir, 'output-marker'),
  }
  const outputMarker = Buffer.from(`dsh-e2b-bootstrap:${randomUUID()}`)
  const output = new PassThrough()
  const outputFilter = new BootstrapOutputFilter(outputMarker, output)
  let handle: CommandHandle | undefined
  let completion: Promise<CommandResult> | undefined
  let stateDirectoryCreated = false
  let controlEnvs: Record<string, string> = {}
  const fail = (error: unknown): Promise<never> => {
    output.destroy()
    let terminalQuiescent = handle === undefined
    let stateRemoved = !stateDirectoryCreated
    const removeState = async (failures: Error[]): Promise<void> => {
      if (!stateRemoved) {
        await sandbox.files.remove(stateDir).then(
          () => { stateRemoved = true },
          (stateError: Thrown) => {
            if (stateError instanceof FileNotFoundError || stateError instanceof SandboxNotFoundError) {
              stateRemoved = true
            } else {
              failures.push(asError(stateError))
            }
          },
        )
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'subprocess-e2b: terminal setup cleanup did not complete')
      }
    }
    const cleanup = (): Promise<void> => {
      const failures: Error[] = []
      if (terminalQuiescent || handle === undefined) return removeState(failures)
      const rolled = completion === undefined
        ? handle.kill()
        : rollbackUnpublishedTerminal(sandbox, handle, completion, controlEnvs, spec.graceMs, pollMs)
      return rolled.then(
        () => {
          terminalQuiescent = true
          return removeState(failures)
        },
        (cleanupError: Thrown) => {
          if (cleanupError instanceof SandboxNotFoundError) terminalQuiescent = true
          else failures.push(asError(cleanupError))
          return removeState(failures)
        },
      )
    }
    return cleanup().then(
      () => { throw error },
      (cleanupError: Thrown) => {
        // TODO(e2b-terminal-setup-rollback): Retain retry state only if a real
        // double failure must be recovered before sandbox disposal or timeout.
        throw new AggregateError([asError(error), asError(cleanupError)], asError(error).message)
      },
    )
  }
  const rejected = (error: Thrown): Promise<never> => fail(error)
  return readRemoteEnvironment(sandbox, spec.signal).then((ambient) => {
    controlEnvs = bootstrapEnvironment(ambient)
    let environment: string
    let argv: string
    try {
      environment = serializeRemoteEnvironment(ambient, spec.env)
      argv = serializeValues(spec.argv, 'argv')
    } catch (error) {
      return fail(error)
    }
    stateDirectoryCreated = true
    return sandbox.files.makeDir(stateDir, signalOpts(spec.signal)).then(
      () => sandbox.commands.run(
        `chmod 700 -- ${quoteE2BShellArg(stateDir)}`,
        commandOpts(controlEnvs, spec.signal),
      ).then(
        () => sandbox.files.write([
          { path: paths.runner, data: TERMINAL_RUNNER_SOURCE },
          { path: paths.environment, data: environment },
          { path: paths.argv, data: argv },
          { path: paths.outputMarker, data: outputMarker.toString('utf8') },
        ], signalOpts(spec.signal)).then(
          () => sandbox.commands.run(
            `chmod 600 -- ${quoteE2BShellArg(paths.runner)} ${quoteE2BShellArg(paths.environment)} ${quoteE2BShellArg(paths.argv)} ${quoteE2BShellArg(paths.outputMarker)}`,
            commandOpts(controlEnvs, spec.signal),
          ).then(
            () => sandbox.pty.create({
              rows: spec.rows,
              cols: spec.cols,
              cwd: spec.cwd,
              envs: e2bControlEnvs(controlEnvs),
              timeoutMs: 0,
              onData: (data) => { outputFilter.push(data) },
            }).then(
              (created) => {
                handle = created
                const live = created
                let liveCompletion: Promise<CommandResult>
                try {
                  liveCompletion = live.wait()
                } catch (error) {
                  return fail(error)
                }
                completion = liveCompletion
                liveCompletion.then(undefined, ignoreRejection)
                if (spec.signal?.aborted === true) return fail(asError(spec.signal.reason))
                if (!Number.isSafeInteger(live.pid) || live.pid <= 0) {
                  return fail(new Error(`subprocess-e2b: E2B returned invalid terminal pid ${live.pid}`))
                }
                const command = `exec /bin/bash ${quoteE2BShellArg(paths.runner)} ${quoteE2BShellArg(stateDir)}\r`
                return sandbox.pty.sendInput(live.pid, Buffer.from(command), signalOpts(spec.signal)).then(
                  () => waitForBootstrapOutput(outputFilter.ready, liveCompletion, spec.signal).then(
                    () => terminalSessionId(sandbox, live.pid, controlEnvs, spec.signal).then(
                      sessionId => new E2BTerminalHandle(
                        sandbox,
                        live,
                        output,
                        liveCompletion,
                        sessionId,
                        controlEnvs,
                        stateDir,
                        spec.graceMs,
                        pollMs,
                      ),
                      rejected,
                    ),
                    rejected,
                  ),
                  rejected,
                )
              },
              rejected,
            ),
            rejected,
          ),
          rejected,
        ),
        rejected,
      ),
      rejected,
    )
  }, rejected)
}
