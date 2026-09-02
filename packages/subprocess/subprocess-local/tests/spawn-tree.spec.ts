import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { childEnv, killGroup, spawnSubprocess, taskkillProcessTree } from '../src/spawn.ts'
import { killQuietly, spec, spillDir, waitForPidFile, waitGone } from './spawn-support.ts'

describe('killGroup', () => {
  it('ignores non-positive pids', () => {
    expect(() => { killGroup(-1, 'SIGTERM') }).not.toThrow()
    expect(() => { killGroup(0, 'SIGTERM') }).not.toThrow()
  })

  it('swallows ESRCH for vanished groups', async () => {
    const running = spawnSubprocess(spec('true'))
    await running.done
    expect(() => { killGroup(running.pid, 'SIGTERM') }).not.toThrow()
  })

  it('never throws, even for EPERM-style failures', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    const killThrew = (() => {
      killGroup(12345, 'SIGTERM')
      return false
    })()
    spy.mockRestore()
    expect(killThrew).toBe(false)
  })
})

describe('AbortSignal lifecycle', () => {
  it('honors AbortSignal on background-style runs (no timeout)', async () => {
    const controller = new AbortController()
    const running = spawnSubprocess(spec('sleep 60', { signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 50)
    const result = await running.done
    expect(result.signal).toBe(process.platform === 'win32' ? null : 'SIGTERM')
  })
})

describe('windows tree semantics (injected platform)', () => {
  it('host-exit termination routes through taskkill immediately', async () => {
    const killed: number[] = []
    const running = spawnSubprocess(spec('exec sleep 60', { graceMs: 60_000 }), {
      spillDir,
      platform: 'win32',
      taskkill: (pid) => {
        killed.push(pid)
        killQuietly(pid)
        return { status: 0, stderr: '' }
      },
    })
    running.terminateForHostExit()
    await running.done
    expect(killed).toEqual([running.pid])
  })

  it('terminate routes through taskkill by root pid', async () => {
    const killed: number[] = []
    const running = spawnSubprocess(spec('exec sleep 60', { graceMs: 100 }), {
      spillDir,
      platform: 'win32',
      taskkill: (pid) => {
        killed.push(pid)
        // Simulate the forced tree termination taskkill performs.
        killQuietly(pid)
        return { status: 0, stderr: '' }
      },
    })
    running.terminate()
    const outcome = await running.done
    expect(killed).toContain(running.pid)
    expect(outcome.signal).toBe(process.platform === 'win32' ? null : 'SIGKILL')
  })

  it('waitForExit falls back to direct-child liveness where groups do not exist', async () => {
    const running = spawnSubprocess(spec('true'), { spillDir, platform: 'win32', taskkill: () => ({ status: 0, stderr: '' }) })
    await running.done
    await expect(running.waitForExit()).resolves.toBe(true)
  })
})

describe('coverage seams', () => {
  it('taskkillProcessTree ignores non-positive pids and contains a missing binary', () => {
    expect(() => { taskkillProcessTree(-1) }).not.toThrow()
    expect(() => { taskkillProcessTree(0) }).not.toThrow()
    // On POSIX there is no taskkill; spawnSync reports the failure in its
    // result and the function stays silent — the same containment Windows
    // relies on for an already-absent tree.
    expect(() => { taskkillProcessTree(2 ** 30) }).not.toThrow()
  })

  it('covers the injected POSIX group paths on any host', async () => {
    // Windows has no POSIX groups, so the tree-liveness probe, group
    // signalling, and the SIGKILL escalation timer only run here through the
    // injected platform; the mock keeps the group alive through TERM and
    // terminates the direct child when the escalation tier delivers SIGKILL.
    const running = spawnSubprocess(spec('sleep 60', { graceMs: 100 }), {
      platform: 'linux',
      linuxProcessGroupHasLiveMembers: () => false,
    })
    const realKill = process.kill.bind(process)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (typeof target === 'number' && target < 0) {
        if (signal === 0) return true
        if (signal === 'SIGKILL') realKill(running.pid, 'SIGKILL')
        return true
      }
      return realKill(target, signal)
    })
    running.terminate()
    await running.done
    const exitVerdict = await running.waitForExit()
    killSpy.mockRestore()
    expect(exitVerdict).toBe(true)
  })

  it('treats a vanished group probe as quiescent without signalling', async () => {
    const running = spawnSubprocess(spec('sleep 60'), { platform: 'linux' })
    const realKill = process.kill.bind(process)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (typeof target === 'number' && target < 0) {
        throw Object.assign(new Error('simulated absent group'), { code: 'ESRCH' })
      }
      return realKill(target, signal)
    })
    running.terminate()
    await new Promise(resolve => setTimeout(resolve, 20))
    realKill(running.pid, 'SIGKILL')
    await running.done
    const exitVerdict = await running.waitForExit()
    killSpy.mockRestore()
    expect(exitVerdict).toBe(true)
  })

  it('childEnv keeps the POSIX spread on non-Windows hosts', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const envValue = childEnv({ DSH_X: '1' }).DSH_X
    platform.mockRestore()
    expect(envValue).toBe('1')
  })

  it('settles through the pipe-drain timer when a descendant holds a collected pipe', async () => {
    // The leader spawns a detached grandchild inheriting the collected stdout
    // pipe, then exits: `close` cannot settle while the grandchild holds the
    // pipe, so the bounded pipe-drain timer must settle the outcome.
    const pidFile = join(spillDir, `pipe-drain-${Date.now()}.pid`)
    const childScript = `
      const { spawn } = require('node:child_process')
      const { writeFileSync } = require('node:fs')
      const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: ['ignore', 1, 2],
      })
      writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid))
      helper.unref()
    `
    const running = spawnSubprocess({
      ...spec('unused', { graceMs: 100 }),
      argv: [process.execPath, '-e', childScript],
    })
    // The drain timer starts when the child's stdio closes, which can precede
    // the pid file becoming visible; measure from before that wait so the
    // lower bound cannot be eroded by the pid-file handoff.
    const started = Date.now()
    const helper = await waitForPidFile(pidFile)
    const outcome = await running.done
    expect(outcome.exitCode).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    killQuietly(helper)
    await waitGone(helper)
  })

  it('a spawn-failed handle rejects done while waitForExit reports gone', async () => {
    const running = spawnSubprocess(spec('true', { cwd: '/nonexistent-dir-dsh-dispose-test' }))
    await expect(running.done).rejects.toThrow()
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it("an 'inherit' stdout with collected stderr wires only the requested collector", async () => {
    const running = spawnSubprocess({
      ...spec('echo to-parent; echo err >&2'),
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: { maxBytes: 1000 } },
    })
    const outcome = await running.done
    expect(outcome.exitCode).toBe(0)
    expect(running.stdout).toBeUndefined()
    expect(running.collected.stdout).toBeUndefined()
    expect(running.collected.stderr!.readFrom(0).text).toBe('err\n')
  })

  it("an 'inherit' stderr with collected stdout wires only the requested collector", async () => {
    const running = spawnSubprocess({
      ...spec('echo out; echo to-parent >&2'),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: 'inherit' },
    })
    const outcome = await running.done
    expect(outcome.exitCode).toBe(0)
    expect(running.stderr).toBeUndefined()
    expect(running.collected.stderr).toBeUndefined()
    expect(running.collected.stdout!.readFrom(0).text).toBe('out\n')
  })

  it('terminate() after the tree died delivers no termination signal', async () => {
    const running = spawnSubprocess(spec('true'))
    await running.done
    const spy = vi.spyOn(process, 'kill')
    running.terminate()
    const delivered = spy.mock.calls.filter(([, sig]) => sig !== 0)
    spy.mockRestore()
    expect(delivered).toEqual([])
    await running.waitForExit()
  })

  it('repeated terminate after exit never probes or signals a reused process group', async () => {
    const running = spawnSubprocess(spec('sleep 60'))
    running.terminate()
    await running.done
    await running.waitForExit()
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    running.terminate()
    const delivered = spy.mock.calls.length
    spy.mockRestore()
    expect(delivered).toBe(0)
  })

  it('waitForExit on a failed spawn reports exited immediately', async () => {
    const running = spawnSubprocess(spec('true', { cwd: '/nonexistent-dir-dsh-spawn-test' }))
    await expect(running.done).rejects.toThrow()
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it('a batch-stdin handle exposes no stdin surface', async () => {
    const running = spawnSubprocess(spec('cat', { stdin: 'batch\n' }))
    expect(running.stdin).toBeUndefined()
    await running.done
    expect(running.collected.stdout!.readFrom(0).text).toBe('batch\n')
  })
})

describe('coverage seams 2', () => {
  it('win32 treeAlive reports alive for a live child and gone after taskkill', async () => {
    let killedPid = 0
    const running = spawnSubprocess(spec('sleep 60'), {
      spillDir,
      platform: 'win32',
      taskkill: (pid) => {
        killedPid = pid
        killQuietly(pid)
        return { status: 0, stderr: '' }
      },
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(running.waitForExit(aborted.signal)).resolves.toBe(false) // alive branch
    running.terminate()
    await running.done
    expect(killedPid).toBe(running.pid)
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it('an inert win32 taskkill leaves the tree alive for a bounded wait to report', async () => {
    // An inert taskkill simulates a tree that never reports exit: terminate()
    // delivers nothing, so a bounded consumer wait must come back false.
    const running = spawnSubprocess(spec('sleep 60'), { spillDir, platform: 'win32', taskkill: () => ({ status: 0, stderr: 'inert' }) })
    running.terminate()
    const bound = new AbortController()
    const timer = setTimeout(() => { bound.abort() }, 60)
    await expect(running.waitForExit(bound.signal)).resolves.toBe(false)
    clearTimeout(timer)
    // Real cleanup: the injected platform spawned without detachment, so the
    // child is a plain (group-less) POSIX process — kill it directly.
    process.kill(running.pid, 'SIGKILL')
    await running.done
  })

  it("stderr: 'pipe' exposes the raw stream", async () => {
    const running = spawnSubprocess({
      ...spec('echo err >&2'),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 }, stderr: 'pipe' },
    })
    expect(running.stderr).toBeDefined()
    const text = new Promise<string>((resolve) => {
      let out = ''
      running.stderr!.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
      running.stderr!.on('end', () => { resolve(out) })
    })
    await running.done
    expect(await text).toBe('err\n')
  })
})
