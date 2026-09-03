/**
 * Windows whole-tree ownership through a Job object, exercised on every host
 * with an injected platform and an injected Job. What the kernel does with a
 * real Job is pinned by dsh-win32-process's primitives; what this provider does
 * with one — attach at spawn, terminate the whole tree, read liveness from the
 * Job rather than the direct child, release the handle, and REPORT every
 * degradation instead of discarding it — is pinned here.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import { JOBOBJECT_ID_LIST_OFFSET } from '@deepseek-ai/dsh-win32-process/src/abi.ts'
import type { NativePtr, Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'
import { spawnSubprocess, taskkillProcessTree } from '../src/spawn.ts'
import type { SpawnInternals, TaskkillOutcome } from '../src/spawn.ts'
import { windowsJobFactory } from '../src/windows-job.ts'
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

const JOB_HANDLE = 0x5100n as NativePtr
const PROCESS_HANDLE = 0x5200n as NativePtr

/**
 * The Win32 process table the Job factory calls, with only the entries the
 * Job primitives reach; the cast keeps the unused stdio and token members out
 * of the stand-in rather than stubbing calls no Job operation makes.
 * @param assignedProcesses - the member count the kernel reports for the Job.
 * @param overrides - entries this case replaces.
 * @returns the stand-in table.
 */
function win32Table(
  assignedProcesses: number,
  overrides: Partial<Win32ProcessBindings> = {},
): Win32ProcessBindings {
  return {
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    closeHandle: vi.fn((_handle: NativePtr) => 1),
    createJobObjectW: vi.fn(() => JOB_HANDLE),
    setInformationJobObject: vi.fn(() => 1),
    openProcess: vi.fn(() => PROCESS_HANDLE),
    assignProcessToJobObject: vi.fn(() => 1),
    terminateJobObject: vi.fn(() => 1),
    queryInformationJobObject: vi.fn((
      _job: NativePtr,
      _cls: number,
      information: Buffer,
      _length: number,
      returned: NativePtr,
    ) => {
      information.writeUInt32LE(assignedProcesses, 0)
      koffi.encode(returned, 'uint32', JOBOBJECT_ID_LIST_OFFSET)
      return 1
    }),
    ...overrides,
  } as unknown as Win32ProcessBindings
}

describe('the Job factory over an injected Win32 table', () => {
  it('creates a kill-on-close Job, joins the leader to it, and answers through that Job', () => {
    const createJobObjectW = vi.fn(() => JOB_HANDLE)
    const openProcess = vi.fn(() => PROCESS_HANDLE)
    const assignProcessToJobObject = vi.fn(() => 1)
    const terminateJobObject = vi.fn(() => 1)
    const closeHandle = vi.fn((_handle: NativePtr) => 1)
    const api = win32Table(3, {
      createJobObjectW,
      openProcess,
      assignProcessToJobObject,
      terminateJobObject,
      closeHandle,
    })
    let resolutions = 0

    const job = windowsJobFactory(() => { resolutions += 1; return api })(4242)

    // Resolved per Job rather than at composition, so building the factory on
    // a host with no Win32 libraries opens nothing.
    expect(resolutions).toBe(1)
    expect(createJobObjectW).toHaveBeenCalledOnce()
    expect(assignProcessToJobObject).toHaveBeenCalledWith(JOB_HANDLE, PROCESS_HANDLE)
    expect(openProcess).toHaveBeenCalledWith(expect.any(Number), 0, 4242)

    expect(job.liveMemberCount()).toBe(3)
    job.terminate()
    expect(terminateJobObject).toHaveBeenCalledWith(JOB_HANDLE, 1)
    job.close()
    expect(closeHandle).toHaveBeenLastCalledWith(JOB_HANDLE)
  })

  it('closes the Job it created when the leader cannot join it', () => {
    // Without this the refused attach would strand a kill-on-close Job for the
    // host's whole life, and its limit would take the tree down at exit.
    const closeHandle = vi.fn((_handle: NativePtr) => 1)
    const api = win32Table(0, { assignProcessToJobObject: vi.fn(() => 0), closeHandle })

    expect(() => windowsJobFactory(() => api)(4242)).toThrow(/AssignProcessToJobObject/)
    expect(closeHandle).toHaveBeenCalledWith(JOB_HANDLE)
  })

  it('reports a Job the kernel refused to create, leaving nothing to release', () => {
    const closeHandle = vi.fn((_handle: NativePtr) => 1)
    const openProcess = vi.fn(() => PROCESS_HANDLE)
    const api = win32Table(0, { createJobObjectW: vi.fn(() => 0n as NativePtr), closeHandle, openProcess })

    expect(() => windowsJobFactory(() => api)(4242)).toThrow(/CreateJobObjectW/)
    expect(openProcess).not.toHaveBeenCalled()
    expect(closeHandle).not.toHaveBeenCalled()
  })
})

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

  it.skipIf(process.platform === 'win32')('separates a taskkill that RAN from one that never started', () => {
    // Windows runs its own taskkill for this arm; off Windows the binary does
    // not exist, so a stand-in on PATH is the only way to reach a report that
    // carries a status and no spawn error.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-taskkill-'))
    writeFileSync(join(dir, 'taskkill'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`)
    try {
      expect(taskkillProcessTree(2 ** 30)).toEqual({ status: 0, stderr: '' })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('emits a process warning for a degradation when the caller injected no sink', async () => {
    // The default sink is what a product host gets: an unreported fallback
    // would leave a tree stopped by a weaker mechanism than the one promised.
    const emitted: Array<[unknown, unknown]> = []
    const emitWarning = vi.spyOn(process, 'emitWarning')
      .mockImplementation((message: unknown, name?: unknown) => { emitted.push([message, name]) })
    try {
      const running = spawnSubprocess(nodeSpec('setTimeout(() => {}, 60000)'), {
        spillDir,
        platform: 'win32',
        windowsJob: () => { throw new Error('no Job objects on this host') },
        taskkill: (pid) => {
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
    } finally {
      emitWarning.mockRestore()
    }
    expect(emitted.some(([message, name]) =>
      name === 'DshSubprocessTeardownWarning'
      && String(message).includes('falling back to taskkill'))).toBe(true)
  })
})
