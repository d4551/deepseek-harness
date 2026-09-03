import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  createWindowsProcessInspector,
  isInvalidHandle,
  lazyWin32Bindings,
  win32Structs,
  windowsProcessInternals,
  windowsProcessTree,
  WindowsProcessInspector,
} from '@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts'
import type {
  NativePtr,
  ProcessEntry,
  Win32Bindings,
  Win32Library,
  Win32LibraryLoader,
  WindowsProcessInspectorInternals,
  WindowsProcessState,
} from '@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts'

function fakeInternals() {
  const entries: ProcessEntry[] = []
  const states = new Map<number, WindowsProcessState>()
  const kills: Array<[number, boolean]> = []
  const counts = { enumerations: 0, stateReads: 0 }
  return {
    counts,
    internals: {
      snapshot: () => { counts.enumerations += 1; return [...entries] },
      processState: (pid) => { counts.stateReads += 1; return states.get(pid) },
      taskkill: (pid: number, force: boolean) => { kills.push([pid, force]) },
    } satisfies WindowsProcessInspectorInternals,
    add(entry: ProcessEntry, started?: string, active = true): void {
      entries.push(entry)
      if (started !== undefined) states.set(entry.pid, { started, active })
    },
    kills,
  }
}

describe('WindowsProcessInspector table enumeration', () => {
  it('enumerates the process table only for questions that need it', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11')
    const inspector = new WindowsProcessInspector(fake.internals)

    // Liveness is a per-handle question on Windows, so a snapshot asked only
    // for liveness must not pay a Toolhelp32 walk. The terminal's Windows
    // teardown polls exactly this way, every 25 ms.
    const observed = inspector.snapshot()
    expect(observed.alive({ pid: 11, started: 't11' })).toBe(true)
    expect(fake.counts.enumerations).toBe(0)

    expect(observed.tree(10)).toHaveLength(2)
    expect(fake.counts.enumerations).toBe(1)

    // A second tree question reuses the same observation.
    observed.tree(10)
    expect(fake.counts.enumerations).toBe(1)
  })
})

describe('windowsProcessTree', () => {
  it('walks a table children-first with readable identities only', () => {
    const started = (pid: number): string | undefined => pid === 12 ? undefined : `t${pid}`
    expect(windowsProcessTree([
      { pid: 10, parentPid: 0 },
      { pid: 11, parentPid: 10 },
      { pid: 12, parentPid: 11 },
      { pid: 13, parentPid: 11 },
      { pid: 14, parentPid: 10 },
    ], 10, started)).toEqual([
      { pid: 13, started: 't13' },
      { pid: 11, started: 't11' },
      { pid: 14, started: 't14' },
      { pid: 10, started: 't10' },
    ])
  })

  it('returns an empty walk for an absent root', () => {
    expect(windowsProcessTree([{ pid: 10, parentPid: 0 }], 99, () => 't')).toEqual([])
  })

  it('terminates on a parent cycle instead of recursing forever', () => {
    const entries = [
      { pid: 10, parentPid: 11 },
      { pid: 11, parentPid: 10 },
    ]
    expect(windowsProcessTree(entries, 10, () => 't')).toHaveLength(2)
  })
})

describe('WindowsProcessInspector (injected internals)', () => {
  it('exposes the shell pid as the pseudo foreground group and never proves stdin waits', () => {
    const fake = fakeInternals()
    const inspector = new WindowsProcessInspector(fake.internals)
    expect(inspector.foregroundPgid(77)).toBe(77)
    expect(inspector.isStdinWaiting(77, 10)).toBe(false)
    expect(inspector.snapshot().session(77)).toEqual([])
  })

  it('delegates tree walks and identity checks to the internals', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11')
    const inspector = new WindowsProcessInspector(fake.internals)
    expect(inspector.snapshot().tree(10)).toEqual([
      { pid: 11, started: 't11' },
      { pid: 10, started: 't10' },
    ])
    expect(inspector.isAlive({ pid: 11, started: 't11' })).toBe(true)
    expect(inspector.isAlive({ pid: 11, started: 'stale' })).toBe(false)
    expect(inspector.isAlive({ pid: 99, started: 't99' })).toBe(false)

    fake.add({ pid: 12, parentPid: 10 }, 't12', false)
    expect(inspector.isAlive({ pid: 12, started: 't12' })).toBe(false)
  })

  it('maps SIGKILL to a forced taskkill and other signals to the grace form', () => {
    const fake = fakeInternals()
    const inspector = new WindowsProcessInspector(fake.internals)
    inspector.signalGroup(77, 'SIGKILL')
    inspector.signalGroup(77, 'SIGTERM')
    inspector.signalGroup(0, 'SIGKILL')
    expect(fake.kills).toEqual([[77, true], [77, false], [0, true]])
  })

  it('signals a process only while its start identity matches', () => {
    const fake = fakeInternals()
    fake.add({ pid: 10, parentPid: 0 }, 't10')
    fake.add({ pid: 11, parentPid: 10 }, 't11', false)
    const inspector = new WindowsProcessInspector(fake.internals)
    inspector.signalProcess({ pid: 10, started: 't10' }, 'SIGKILL')
    inspector.signalProcess({ pid: 11, started: 't11' }, 'SIGKILL')
    inspector.signalProcess({ pid: 10, started: 'stale' }, 'SIGTERM')
    expect(fake.kills).toEqual([[10, true]])
  })

  it('accepts an injected internals factory through the creator', () => {
    const fake = fakeInternals()
    expect(createWindowsProcessInspector(fake.internals)).toBeInstanceOf(WindowsProcessInspector)
    expect(createWindowsProcessInspector()).toBeInstanceOf(WindowsProcessInspector)
  })
})

describe('isInvalidHandle', () => {
  it('rejects null, zero, and the all-ones INVALID_HANDLE_VALUE forms', () => {
    const ptr = (value: bigint): NativePtr => value as NativePtr
    expect(isInvalidHandle(null)).toBe(true)
    expect(isInvalidHandle(undefined)).toBe(true)
    expect(isInvalidHandle(ptr(0n))).toBe(true)
    expect(isInvalidHandle(ptr(0xFFFFFFFFFFFFFFFFn))).toBe(true)
    expect(isInvalidHandle(ptr(-1n))).toBe(true)
    expect(isInvalidHandle(ptr(1234n))).toBe(false)
  })
})

/**
 * The kernel32 exports the inspector binds, mapped to the binding-table member
 * each one fills. A stand-in library resolves through this map, so a rename or
 * a mis-wired member fails here instead of at the first Windows call.
 */
const KERNEL32_EXPORTS: Record<string, keyof Win32Bindings> = {
  CreateToolhelp32Snapshot: 'createToolhelp32Snapshot',
  Process32FirstW: 'process32FirstW',
  Process32NextW: 'process32NextW',
  OpenProcess: 'openProcess',
  GetProcessTimes: 'getProcessTimes',
  WaitForSingleObject: 'waitForSingleObject',
  CloseHandle: 'closeHandle',
}

/** What a stand-in library was asked to open and bind. */
interface LibraryLog {
  opened: string[]
  bound: string[]
}

/**
 * A library loader that answers with a staged process table.
 * @param table - the calls the bound functions dispatch to.
 * @param log - recorder for the library name and each binding request.
 * @returns the loader to hand {@link lazyWin32Bindings}.
 */
function fakeKernel32(table: Win32Bindings, log: LibraryLog): Win32LibraryLoader {
  return (name) => {
    log.opened.push(name)
    const library: Win32Library = {
      func: (convention, exported) => {
        log.bound.push(`${convention} ${exported}`)
        const member = KERNEL32_EXPORTS[exported]
        if (member === undefined) throw new Error(`fake kernel32 exports no ${exported}`)
        return table[member]
      },
    }
    return library
  }
}

const SNAPSHOT_HANDLE = 0x9100n as NativePtr
const PROCESS_HANDLE = 0x9200n as NativePtr
const INVALID_HANDLE = 0xFFFFFFFFFFFFFFFFn as NativePtr
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x102

/** One process-table row a staged Toolhelp32 walk hands back. */
interface StagedRow {
  pid: number
  parentPid: number
}

/**
 * A Win32 table whose Toolhelp32 walk yields `rows` and whose process state is
 * a running process started at `11:7`.
 * @param rows - the process-table rows the walk yields, in table order.
 * @param overrides - calls this case answers differently.
 * @returns the staged table.
 */
function stagedWin32(rows: StagedRow[], overrides: Partial<Win32Bindings> = {}): Win32Bindings {
  const { PROCESSENTRY32W, FILETIME } = win32Structs()
  let cursor = 0
  const writeRow = (entry: NativePtr): number => {
    const row = rows[cursor]
    if (row === undefined) return 0
    cursor += 1
    koffi.encode(entry, PROCESSENTRY32W, {
      dwSize: PROCESSENTRY32W.size,
      cntUsage: 0,
      th32ProcessID: row.pid,
      th32DefaultHeapID: null,
      th32ModuleID: 0,
      cCntThreads: 1,
      th32ParentProcessID: row.parentPid,
      pcPriClassBase: 0,
      dwFlags: 0,
      szExeFile: 'stub.exe',
    })
    return 1
  }
  return {
    createToolhelp32Snapshot: () => SNAPSHOT_HANDLE,
    process32FirstW: (_snapshot, entry) => { cursor = 0; return writeRow(entry) },
    process32NextW: (_snapshot, entry) => writeRow(entry),
    openProcess: () => PROCESS_HANDLE,
    getProcessTimes: (_process, creation) => {
      koffi.encode(creation, FILETIME, { dwLowDateTime: 7, dwHighDateTime: 11 })
      return 1
    },
    waitForSingleObject: () => WAIT_TIMEOUT,
    closeHandle: () => 1,
    ...overrides,
  }
}

/**
 * Internals over a staged kernel32.
 * @param table - the staged Win32 table.
 * @param log - recorder for library opens and bindings.
 * @returns the koffi-backed internals reading that table.
 */
function stagedInternals(table: Win32Bindings, log: LibraryLog = { opened: [], bound: [] }): WindowsProcessInspectorInternals {
  return windowsProcessInternals(lazyWin32Bindings(fakeKernel32(table, log)))
}

describe('the koffi-backed Windows process table', () => {
  it('binds every kernel32 export the table declares, as __stdcall, on first use', () => {
    const log: LibraryLog = { opened: [], bound: [] }
    const internals = stagedInternals(stagedWin32([{ pid: 10, parentPid: 0 }]), log)

    // Constructing internals opens nothing: a POSIX host reaches this line
    // with no Win32 library loaded at all.
    expect(log.opened).toEqual([])

    internals.snapshot()
    expect(log.opened).toEqual(['kernel32.dll'])
    expect(log.bound).toEqual([
      '__stdcall CreateToolhelp32Snapshot',
      '__stdcall Process32FirstW',
      '__stdcall Process32NextW',
      '__stdcall OpenProcess',
      '__stdcall GetProcessTimes',
      '__stdcall WaitForSingleObject',
      '__stdcall CloseHandle',
    ])
  })

  it('opens the library once, however many questions the table is asked', () => {
    const log: LibraryLog = { opened: [], bound: [] }
    const internals = stagedInternals(stagedWin32([{ pid: 10, parentPid: 0 }]), log)
    internals.snapshot()
    internals.snapshot()
    internals.processState(10)
    expect(log.opened).toEqual(['kernel32.dll'])
  })

  it('enumerates the process table and releases the snapshot handle', () => {
    const closed: NativePtr[] = []
    const internals = stagedInternals(stagedWin32(
      [{ pid: 10, parentPid: 4 }, { pid: 11, parentPid: 10 }, { pid: 12, parentPid: 11 }],
      { closeHandle: (handle) => { closed.push(handle); return 1 } },
    ))

    expect(internals.snapshot()).toEqual([
      { pid: 10, parentPid: 4 },
      { pid: 11, parentPid: 10 },
      { pid: 12, parentPid: 11 },
    ])
    expect(closed).toEqual([SNAPSHOT_HANDLE])
  })

  it('reads an unreadable snapshot as an empty table instead of failing the question', () => {
    const first = vi.fn(() => 1)
    const internals = stagedInternals(stagedWin32([{ pid: 10, parentPid: 0 }], {
      createToolhelp32Snapshot: () => INVALID_HANDLE,
      process32FirstW: first,
    }))

    expect(internals.snapshot()).toEqual([])
    expect(first).not.toHaveBeenCalled()
  })

  it('reports a running process as its creation identity plus a live wait state', () => {
    const closed: NativePtr[] = []
    const internals = stagedInternals(stagedWin32([], {
      closeHandle: (handle) => { closed.push(handle); return 1 },
    }))

    expect(internals.processState(4242)).toEqual({ started: '11:7', active: true })
    expect(closed).toEqual([PROCESS_HANDLE])
  })

  it('reports an exited process as the same identity with a settled wait state', () => {
    const internals = stagedInternals(stagedWin32([], { waitForSingleObject: () => WAIT_OBJECT_0 }))
    expect(internals.processState(4242)).toEqual({ started: '11:7', active: false })
  })

  it('reads a process it cannot open as unreadable', () => {
    const internals = stagedInternals(stagedWin32([], { openProcess: () => 0n as NativePtr }))
    expect(internals.processState(4242)).toBeUndefined()
  })

  it('reads an unreadable creation time as unreadable, releasing the process handle', () => {
    const closed: NativePtr[] = []
    const internals = stagedInternals(stagedWin32([], {
      getProcessTimes: () => 0,
      closeHandle: (handle) => { closed.push(handle); return 1 },
    }))

    expect(internals.processState(4242)).toBeUndefined()
    expect(closed).toEqual([PROCESS_HANDLE])
  })

  it('refuses to read a liveness claim out of an unexpected wait result', () => {
    const internals = stagedInternals(stagedWin32([], { waitForSingleObject: () => 0xFFFFFFFF }))
    expect(internals.processState(4242)).toBeUndefined()
  })

  it('never runs taskkill for a non-positive pid', () => {
    const internals = stagedInternals(stagedWin32([]))
    // A failed spawn reports pid 0; `taskkill /PID 0 /T /F` would target the
    // System Idle Process instead of nothing.
    expect(() => { internals.taskkill(0, false) }).not.toThrow()
  })

  it.each([true, false])('tolerates a taskkill attempt that terminated nothing (force: %s)', (force) => {
    const internals = stagedInternals(stagedWin32([]))
    // An absent tree, an exit race, and a POSIX host with no taskkill binary at
    // all are equally tolerable, exactly as ESRCH is for POSIX group signalling.
    expect(() => { internals.taskkill(2 ** 30, force) }).not.toThrow()
  })
})

const win32 = process.platform === 'win32' ? describe : describe.skip

win32('WindowsProcessInspector over the real koffi bindings', () => {
  it('walks the live process table from the test runner itself', () => {
    const inspector = createWindowsProcessInspector()
    const tree = inspector.snapshot().tree(process.pid)
    const self = tree.find(member => member.pid === process.pid)
    expect(self).toBeDefined()
    expect(inspector.snapshot().alive(self!)).toBe(true)
    expect(inspector.foregroundPgid(process.pid)).toBe(process.pid)
  })

  it('reports unreadable identities for absent processes and no-ops tree signalling', () => {
    const inspector = createWindowsProcessInspector()
    expect(inspector.isAlive({ pid: 0x7FFFFFFF, started: 'absent' })).toBe(false)
    expect(() => { inspector.signalGroup(0x7FFFFFFF, 'SIGKILL') }).not.toThrow()
    expect(() => { inspector.signalGroup(0x7FFFFFFF, 'SIGTERM') }).not.toThrow()
    expect(() => { inspector.signalGroup(0, 'SIGKILL') }).not.toThrow()
    expect(() => { inspector.signalProcess({ pid: 0x7FFFFFFF, started: 'absent' }, 'SIGKILL') }).not.toThrow()
  })
})
