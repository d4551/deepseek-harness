/**
 * Windows whole-tree ownership through a Job object, exercised on every host
 * with an injected platform and an injected Job. What the kernel does with a
 * real Job is pinned by dsh-win32-process's primitives; what this provider does
 * with one — attach at spawn, terminate the whole tree, read liveness from the
 * Job rather than the direct child, release the handle, and REPORT every
 * degradation instead of discarding it — is pinned here.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnSubprocess, taskkillProcessTree } from '../src/spawn.ts'
import type { SpawnInternals, TaskkillOutcome } from '../src/spawn.ts'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-job-'))

/** A spawn spec for a node one-liner, so no shell is required on any host. */
function nodeSpec(script: string, graceMs = 100): SubprocessSpawnSpec {
  return {
    argv: [process.execPath, '-e', script],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64_000 },
      stderr: { maxBytes: 64_000 },
    },
    graceMs,
  }
}

/** What an injected Job was asked to do. */
interface JobLog {
  created: number[]
  terminated: number[]
  closed: number[]
}

function jobLog(): JobLog {
  return { created: [], terminated: [], closed: [] }
}

/**
 * A Job stand-in that really stops the child it names, and then reports the
 * empty tree the kernel would report after `TerminateJobObject`.
 * @param log - recorder for the calls the provider makes.
 * @returns the injectable Job factory.
 */
function killingJob(log: JobLog): NonNullable<SpawnInternals['windowsJob']> {
  return (pid) => {
    log.created.push(pid)
    let members = 1
    return {
      terminate: () => {
        log.terminated.push(pid)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone — the kernel Job reports the same empty tree.
        }
        members = 0
      },
      liveMemberCount: () => members,
      close: () => { log.closed.push(pid) },
    }
  }
}

/** A taskkill stand-in reporting a clean termination without touching anything. */
const inertTaskkill = (): TaskkillOutcome => ({ status: 0, stderr: '' })

describe('the Windows Job that owns a spawned tree', () => {
  it('attaches the leader at spawn and stops the whole Job on termination', async () => {
    const log = jobLog()
    const running = spawnSubprocess(nodeSpec('setTimeout(() => {}, 60000)'), {
      spillDir,
      platform: 'win32',
      windowsJob: killingJob(log),
      taskkill: inertTaskkill,
    })

    expect(log.created).toEqual([running.pid])
    running.terminate()
    await running.done
    await expect(running.waitForExit()).resolves.toBe(true)

    expect(log.terminated).toEqual([running.pid])
    // Holding the handle open would keep the kernel object — and, under
    // kill-on-close, its claim on the tree — for the host's whole life.
    expect(log.closed).toEqual([running.pid])
  })

  it('stops the Job immediately on host exit, without the escalation ladder', async () => {
    const log = jobLog()
    const running = spawnSubprocess(nodeSpec('setTimeout(() => {}, 60000)', 60_000), {
      spillDir,
      platform: 'win32',
      windowsJob: killingJob(log),
      taskkill: inertTaskkill,
    })

    running.terminateForHostExit()
    await running.done

    expect(log.terminated).toEqual([running.pid])
  })

  it('reads whole-tree liveness from the Job, not from the direct child', async () => {
    // A member still assigned after the direct child settles is exactly the
    // surviving-descendant case a pid-shaped Windows probe cannot see.
    let members = 2
    const running = spawnSubprocess(nodeSpec(''), {
      spillDir,
      platform: 'win32',
      taskkill: inertTaskkill,
      windowsJob: () => ({
        terminate: () => { members = 0 },
        liveMemberCount: () => members,
        close: () => {},
      }),
    })
    await running.done

    const bound = new AbortController()
    const timer = setTimeout(() => { bound.abort() }, 60)
    await expect(running.waitForExit(bound.signal)).resolves.toBe(false)
    clearTimeout(timer)

    members = 0
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it('falls back to taskkill, and says so, when the kernel refuses a Job', async () => {
    const warnings: string[] = []
    const killed: number[] = []
    const running = spawnSubprocess(nodeSpec('setTimeout(() => {}, 60000)'), {
      spillDir,
      platform: 'win32',
      warn: message => warnings.push(message),
      windowsJob: () => { throw new Error('AssignProcessToJobObject failed (Win32 5)') },
      taskkill: (pid) => {
        killed.push(pid)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone — matches taskkill's tolerated not-found status.
        }
        return { status: 0, stderr: '' }
      },
    })

    running.terminate()
    await running.done

    expect(killed).toContain(running.pid)
    expect(warnings.join('\n')).toMatch(/could not be placed in a Job object, falling back to taskkill/)
    // Without a Job there is no whole-tree reading left; the degradation was
    // reported at the moment it happened rather than inferred later.
    await expect(running.waitForExit()).resolves.toBe(true)
  })

  it('reports a taskkill fallback that did not terminate the tree', async () => {
    const warnings: string[] = []
    const running = spawnSubprocess(nodeSpec('setTimeout(() => {}, 60000)'), {
      spillDir,
      platform: 'win32',
      warn: message => warnings.push(message),
      windowsJob: () => { throw new Error('no Job') },
      taskkill: () => ({ status: 1, stderr: 'ERROR: The process could not be terminated.\n' }),
    })

    running.terminateForHostExit()

    expect(warnings.join('\n')).toMatch(/taskkill of pid \d+ did not terminate the tree \(status 1\)/)
    expect(warnings.join('\n')).toMatch(/could not be terminated/)
    // The stand-in terminated nothing, so the still-live child is this test's
    // to reap: the injected platform spawned it without a process group.
    process.kill(running.pid, 'SIGKILL')
    await running.done
  })

  it('reports a taskkill binary that could not be started at all', async () => {
    const warnings: string[] = []
    const running = spawnSubprocess(nodeSpec('setTimeout(() => {}, 60000)'), {
      spillDir,
      platform: 'win32',
      warn: message => warnings.push(message),
      windowsJob: () => { throw new Error('no Job') },
      taskkill: () => ({ status: null, error: new Error('spawnSync taskkill ENOENT'), stderr: '' }),
    })

    running.terminateForHostExit()

    expect(warnings.join('\n')).toMatch(/spawnSync taskkill ENOENT/)
    process.kill(running.pid, 'SIGKILL')
    await running.done
  })

  it('falls back to taskkill when the Job itself refuses every call', async () => {
    const warnings: string[] = []
    const killed: number[] = []
    const running = spawnSubprocess(nodeSpec('setTimeout(() => {}, 60000)'), {
      spillDir,
      platform: 'win32',
      warn: message => warnings.push(message),
      windowsJob: () => ({
        terminate: () => { throw new Error('TerminateJobObject failed (Win32 5)') },
        liveMemberCount: () => { throw new Error('QueryInformationJobObject failed (Win32 6)') },
        close: () => { throw new Error('CloseHandle failed (Win32 6)') },
      }),
      taskkill: (pid) => {
        killed.push(pid)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
        return { status: 0, stderr: '' }
      },
    })

    running.terminate()
    await running.done
    await running.waitForExit()

    expect(killed).toContain(running.pid)
    expect(warnings.join('\n')).toMatch(/Job termination of pid \d+ failed, falling back to taskkill/)
    expect(warnings.join('\n')).toMatch(/Job liveness query for pid \d+ failed/)
    expect(warnings.join('\n')).toMatch(/releasing the Job for pid \d+ failed/)
  })

  it('reports what a real taskkill attempt returned rather than discarding it', () => {
    // A non-positive pid is the failed-spawn no-op; a pid that cannot exist
    // exercises the real spawn, which on POSIX has no taskkill binary at all.
    expect(taskkillProcessTree(-1)).toEqual({ status: 0, stderr: '' })
    const attempt = taskkillProcessTree(2 ** 30)
    expect(attempt.status === null || typeof attempt.status === 'number').toBe(true)
  })
})
