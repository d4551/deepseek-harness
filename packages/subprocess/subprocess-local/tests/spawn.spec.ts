import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { spawnSubprocess } from '../src/spawn.ts'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { finish, killQuietly, spec, spillDir, waitForPidFile, waitForStdout, waitGone } from './spawn-support.ts'

describe('spawnSubprocess', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1])(
    'rejects an invalid grace before spawning: %s',
    (graceMs) => {
      expect(() => spawnSubprocess(spec('true', { graceMs })))
        .toThrow(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
    },
  )

  it('captures stdout on success', async () => {
    const result = await finish(spawnSubprocess(spec('echo hello')))
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.stdout.text).toBe('hello\n')
    expect(result.stdout.truncated).toBe(false)
    expect(result.stderr.text).toBe('')
  })

  it('captures stderr separately', async () => {
    const result = await finish(spawnSubprocess(spec('echo oops >&2')))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('')
    expect(result.stderr.text).toBe('oops\n')
  })

  it('captures both streams', async () => {
    const result = await finish(spawnSubprocess(spec('echo out; echo err >&2')))
    expect(result.stdout.text).toBe('out\n')
    expect(result.stderr.text).toBe('err\n')
  })

  it('reports non-zero exit codes', async () => {
    const result = await finish(spawnSubprocess(spec('exit 42')))
    expect(result.exitCode).toBe(42)
    expect(result.signal).toBeNull()
  })

  it('passes the ambient TERM through untouched (terminal policy is the caller\'s)', async () => {
    const result = await finish(spawnSubprocess(spec('echo "${TERM:-unset}"', {
      env: { TERM: 'callers-choice' },
    })))
    expect(result.stdout.text).toBe('callers-choice\n')
  })

  it.skipIf(process.platform === 'win32')('runs in the requested cwd', async () => {
    const result = await finish(spawnSubprocess(spec('pwd', { cwd: '/tmp' })))
    expect(result.stdout.text.trim()).toMatch(/\/tmp$/)
  })

  it('kills the process group with SIGTERM when the signal fires', async () => {
    // spawnSubprocess owns no timer: it kills on abort. The bash executor drives the timeout
    // by firing this signal via a deadline (see executor.spec.ts); here we
    // assert the kill itself lands as SIGTERM.
    const controller = new AbortController()
    const start = Date.now()
    const running = spawnSubprocess(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort('deadline') }, 100)
    const result = await running.done
    expect(Date.now() - start).toBeLessThan(5_000)
    // Windows teardown terminates through taskkill, which reports no signal.
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
    expect(result.exitCode).toBe(process.platform === 'win32' ? 1 : null)
  })

  it.skipIf(process.platform === 'win32')('terminate() escalates to SIGKILL when SIGTERM is trapped', async () => {
    const running = spawnSubprocess(spec('trap \'\' TERM; echo ready; while :; do sleep 60 & wait $!; done', { graceMs: 200 }))
    await waitForStdout(running, 'ready\n')
    running.terminate()
    const result = await running.done
    expect(result.signal).toBe('SIGKILL')
  })

  it('cancels escalation when the terminated group vanishes before collected pipes drain', async () => {
    const pidFile = join(spillDir, `escaped-pipe-holder-${Date.now()}.pid`)
    const graceMs = 160
    const childScript = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: ['ignore', 1, 2],
      })
      writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid))
      helper.unref()
      setInterval(() => { Date.now() }, 1000)
    `
    const running = spawnSubprocess({
      ...spec('unused', { graceMs }),
      argv: [process.execPath, '-e', childScript],
    })
    const helper = await waitForPidFile(pidFile)
    const realKill: typeof process.kill = process.kill.bind(process)
    let termAt = 0
    let forceSignals = 0
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target !== -running.pid) return realKill(target, signal)
      if (signal === 'SIGTERM') {
        termAt = Date.now()
        return realKill(target, signal)
      }
      if (signal === 'SIGKILL') {
        forceSignals += 1
        return true
      }
      if (signal === 0 && termAt !== 0 && Date.now() - termAt < graceMs / 2) {
        throw Object.assign(new Error('simulated vanished process group'), { code: 'ESRCH' })
      }
      return true // Before TERM the original group is live; later its pgid is reused.
    })
    running.terminate()
    await running.done
    killSpy.mockRestore()
    killQuietly(helper)
    await waitGone(helper)
    expect(forceSignals).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('terminates the whole process group (grandchildren die too)', async () => {
    // The subshell writes the sleep's pid then waits on it; terminating the
    // group must take the sleep down with bash.
    const pidFile = join(spillDir, `grandchild-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(`sleep 60 & echo $! > ${pidFile}; wait`))
    const grandchild = await waitForPidFile(pidFile)
    expect(grandchild).toBeGreaterThan(0)

    running.terminate()
    const result = await running.done
    expect(result.signal).toBe('SIGTERM')
    await waitGone(grandchild)
  })

  it('aborts via AbortSignal mid-run', async () => {
    const controller = new AbortController()
    const running = spawnSubprocess(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort('user cancelled') }, 50)
    const result = await running.done
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
  })

  it('throws when the signal is already aborted before spawn', () => {
    const controller = new AbortController()
    controller.abort('too late')
    expect(() => spawnSubprocess(spec('echo hi', { signal: controller.signal })))
      .toThrow(/aborted before spawn: too late/)
  })

  it('rejects with a spawn error for a nonexistent cwd', async () => {
    await expect(spawnSubprocess(spec('echo hi', { cwd: '/nonexistent-dir-dsh-test' })).done)
      .rejects.toThrow(/ENOENT/)
  })

  it('terminate() is idempotent (second call does not restart escalation)', async () => {
    const running = spawnSubprocess(spec('sleep 60'))
    running.terminate()
    running.terminate()
    const result = await running.done
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
  })

  it.skipIf(process.platform === 'win32')('does not wait for a Linux group that has only zombie members', async () => {
    const pidFile = join(spillDir, `zombie-group-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(`sleep 60 & echo $! > ${pidFile}; echo leader-done`, { graceMs: 100 }), {
      platform: 'linux',
      linuxProcessGroupHasLiveMembers: () => false,
    })
    const descendant = await waitForPidFile(pidFile)
    await running.done
    const exitVerdict = await running.waitForExit()
    // The confirmed-absent verdict is a permanent no-more-signals boundary,
    // so terminate() must stay inert here; reap the live survivor directly.
    process.kill(descendant, 'SIGKILL')
    await waitGone(descendant)
    expect(exitVerdict).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('bounds inherited-pipe draining after the shell exits', async () => {
    const pidFile = join(spillDir, `pipe-holder-${Date.now()}.pid`)
    const started = Date.now()
    const running = spawnSubprocess(spec(`sleep 60 & echo $! > ${pidFile}; echo shell-done`, { graceMs: 100 }))
    const descendant = await waitForPidFile(pidFile)
    const result = await finish(running)
    const elapsed = Date.now() - started
    process.kill(descendant, 'SIGKILL')
    await waitGone(descendant)
    expect(elapsed).toBeLessThan(1_000)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('shell-done\n')
  })
})

describe('stdin and extra env (set by in-process plugins)', () => {
  it('writes stdin to the command and closes it', async () => {
    const result = await finish(spawnSubprocess(spec('cat', { stdin: 'hello from stdin\n' })))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hello from stdin\n')
  })

  it('a command that reads stdin sees EOF when none is supplied', async () => {
    // No stdin → fd 0 is /dev/null, so `cat` reads EOF and exits 0 with no
    // output (it does NOT block).
    const result = await finish(spawnSubprocess(spec('cat')))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('')
  })

  it.skipIf(process.platform === 'win32')('gives fd 0 the exact pre-seam type: /dev/null when no stdin, a pipe when supplied', async () => {
    // With no bytes, fd 0 remains the pre-spawn `ignore` default (/dev/null, a character device).
    // Supplied bytes use Node's spawn pipe, which is an AF_UNIX socket rather than a FIFO.
    const none = await finish(spawnSubprocess(spec('test -c /dev/stdin && echo char || echo other')))
    expect(none.stdout.text).toBe('char\n')
    const piped = await finish(spawnSubprocess(spec('test -S /dev/stdin && echo socket || echo other', { stdin: 'x' })))
    expect(piped.stdout.text).toBe('socket\n')
  })

  it('merges ordinary extra env entries onto the scrubbed environment', async () => {
    const result = await finish(spawnSubprocess(spec('echo "$EXTRA_ONE/$EXTRA_TWO"', {
      env: { EXTRA_ONE: 'alpha', EXTRA_TWO: 'beta' },
    })))
    expect(result.stdout.text).toBe('alpha/beta\n')
  })

  it('lets an explicit tombstone remove an ordinary ambient env entry', async () => {
    vi.stubEnv('SUBPROCESS_TOMBSTONE_PROBE', 'ambient-value')
    const result = await finish(spawnSubprocess(spec(
      'echo "${SUBPROCESS_TOMBSTONE_PROBE:-absent}"',
      { env: { SUBPROCESS_TOMBSTONE_PROBE: undefined } },
    )))
    expect(result.stdout.text).toBe('absent\n')
    vi.unstubAllEnvs()
  })

  it('an explicit extra env entry overrides the credential scrub', async () => {
    // EXPLICIT_OVERRIDE_PASSWORD matches the credential scrub pattern, yet an explicit
    // entry is still honored — the scrub only drops AMBIENT process.env creds.
    const result = await finish(spawnSubprocess(spec('echo "$EXPLICIT_OVERRIDE_PASSWORD"', {
      env: { EXPLICIT_OVERRIDE_PASSWORD: 'explicit-wins' },
    })))
    expect(result.stdout.text).toBe('explicit-wins\n')
  })

  it('does not crash or reject when the child ignores a large stdin (EPIPE)', async () => {
    // The child exits without reading, so closing a stdin pipe holding ~1 MiB triggers EPIPE.
    // The handler swallows that write error and `done` reports the child's real exit.
    const big = 'x'.repeat(1024 * 1024)
    const result = await finish(spawnSubprocess(spec('exit 7', { stdin: big })))
    expect(result.exitCode).toBe(7)
  })
})

describe('waitForExit', () => {
  it.skipIf(process.platform === 'win32')('waits for the whole detached tree, not just the shell', async () => {
    const pidFile = join(spillDir, `tree-wait-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(`sleep 60 & echo $! > ${pidFile}; wait`))
    const grandchild = await waitForPidFile(pidFile)
    running.terminate()
    await running.done
    await expect(running.waitForExit()).resolves.toBe(true)
    await expect(waitGone(grandchild, 100)).resolves.toBeUndefined()
  })

  it('an aborted wait reports false while the tree lives', async () => {
    const running = spawnSubprocess(spec('sleep 60'))
    const controller = new AbortController()
    controller.abort()
    await expect(running.waitForExit(controller.signal)).resolves.toBe(false)
    running.terminate()
    await running.done
  })
})

describe.skipIf(process.platform === 'win32')('synchronous host-exit termination', () => {
  it('force-kills the current process tree without waiting for the normal grace', async () => {
    const running = spawnSubprocess(spec('trap "" TERM; sleep 60', { graceMs: 60_000 }))
    running.terminateForHostExit()
    await expect(running.done).resolves.toMatchObject({ exitCode: null, signal: 'SIGKILL' })
    await expect(running.waitForExit()).resolves.toBe(true)

    const kill = vi.spyOn(process, 'kill')
    running.terminateForHostExit()
    const delivered = kill.mock.calls.length
    kill.mockRestore()
    expect(delivered).toBe(0)
  })
})

describe.skipIf(process.platform === 'win32')('tree-survivor escalation (terminate and bounded waits reach helpers the leader left behind)', () => {
  it('terminate() SIGKILLs a TERM-trapping descendant after the direct child settles', async () => {
    // The leader spawns a TERM-trapping helper with all stdio detached from
    // the collected pipes, then exits: the helper holds the GROUP alive while
    // the direct child settles. The escalation must still reach it.
    const pidFile = join(spillDir, `survivor-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(
      `bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' >/dev/null 2>&1 & disown; wait_placeholder=; exit 0`,
      { graceMs: 300 },
    ))
    const helper = await waitForPidFile(pidFile)
    await running.done // direct child settled; helper survives in the group
    expect(() => process.kill(helper, 0)).not.toThrow()

    running.terminate() // SIGTERM (trapped) → grace → SIGKILL the group
    await expect(running.waitForExit()).resolves.toBe(true)
    await waitGone(helper)
  })

  it('a bounded waitForExit reports false while a survivor lives, true after escalation', async () => {
    const pidFile = join(spillDir, `survivor-wait-${Date.now()}.pid`)
    const running = spawnSubprocess(spec(
      `bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' >/dev/null 2>&1 & disown; exit 0`,
      { graceMs: 200 },
    ))
    const helper = await waitForPidFile(pidFile)
    await running.done
    // A consumer-owned teardown tier bounds its wait and reads the verdict.
    const bound = new AbortController()
    const timer = setTimeout(() => { bound.abort() }, 100)
    await expect(running.waitForExit(bound.signal)).resolves.toBe(false)
    clearTimeout(timer)
    running.terminate()
    await expect(running.waitForExit()).resolves.toBe(true)
    await expect(waitGone(helper)).resolves.toBeUndefined()
  })

  it('service teardown awaits tree survivors, not just handle settlement', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as InstanceType<typeof LocalSubprocessRuntime>).internals = { spillDir }
    const pidFile = join(spillDir, `survivor-svc-${Date.now()}.pid`)
    const running = ctx.subprocess.spawn(spec(
      `bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 60' >/dev/null 2>&1 & disown; exit 0`,
      { graceMs: 200 },
    ))
    const helper = await waitForPidFile(pidFile)
    await running.done
    await fiber.dispose()
    // Teardown itself waited for the survivor to become quiescent.
    await expect(waitGone(helper)).resolves.toBeUndefined()
  })
})

describe('argv validation', () => {
  it('rejects an empty argv before spawning', () => {
    expect(() => spawnSubprocess({ ...spec('true'), argv: [] })).toThrow(/non-empty program name/)
  })

  it('rejects an empty program name before spawning', () => {
    expect(() => spawnSubprocess({ ...spec('true'), argv: [''] })).toThrow(/non-empty program name/)
  })

  it.skipIf(process.platform === 'win32')('spawns argv verbatim without shell interpretation', async () => {
    const result = await finish(spawnSubprocess({ ...spec('unused'), argv: ['printf', '%s', '$HOME'] }))
    expect(result.stdout.text).toBe('$HOME')
  })
})

describe('abort edge cases', () => {
  it('reports a fallback reason for reason-less pre-aborted signals', () => {
    // Real AbortControllers always set a DOMException reason; signal-like
    // objects from other libraries may not — the fallback covers them.
    const controller = new AbortController()
    controller.abort()
    // Strip the DOMException reason real controllers always set, simulating
    // signal-like objects from other libraries that omit it.
    Object.defineProperty(controller.signal, 'reason', { value: undefined })
    expect(() => spawnSubprocess(spec('echo hi', { signal: controller.signal })))
      .toThrow(/aborted before spawn: aborted/)
  })

  it.skipIf(process.platform === 'win32')('reports the terminating signal of an externally self-killed command', async () => {
    // spawnSubprocess reports the raw signal; whether it counts as timeout/cancel is the
    // executor's classification (a self-kill is neither) — see executor.spec.ts.
    const result = await finish(spawnSubprocess(spec('kill -TERM $$')))
    expect(result.signal).toBe('SIGTERM')
  })
})
