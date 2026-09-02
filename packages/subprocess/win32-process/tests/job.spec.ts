/**
 * Job-object ownership for an already-created process, driven through an
 * injected binding table so every failure path is pinned on every host.
 */

import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import { Win32Error } from '../src/errors.ts'
import {
  attachProcessToJob,
  createKillOnCloseJob,
  jobAssignedProcessCount,
  terminateJob,
} from '../src/job.ts'
import {
  ERROR_MORE_DATA,
  JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
  JOBOBJECT_ID_LIST_OFFSET,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JobObjectBasicProcessIdList,
  JobObjectExtendedLimitInformation,
  PROCESS_SET_QUOTA,
  PROCESS_TERMINATE,
} from '../src/abi.ts'
import type { NativePtr, Win32ProcessBindings } from '../src/ffi.ts'

const JOB = 70n as NativePtr
const PROCESS = 71n as NativePtr

function api(overrides: Partial<Win32ProcessBindings> = {}): Win32ProcessBindings {
  return {
    closeHandle: vi.fn((_handle: NativePtr) => 1),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    createPipe: vi.fn(() => 1),
    setHandleInformation: vi.fn(() => 1),
    createProcessAsUserW: vi.fn(() => 1),
    readFile: vi.fn(() => 1),
    peekNamedPipe: vi.fn(() => 1),
    waitForSingleObject: vi.fn(() => 1),
    getExitCodeProcess: vi.fn(() => 1),
    createJobObjectW: vi.fn(() => JOB),
    setInformationJobObject: vi.fn(() => 1),
    assignProcessToJobObject: vi.fn(() => 1),
    terminateJobObject: vi.fn(() => 1),
    queryInformationJobObject: vi.fn(() => 1),
    openProcess: vi.fn(() => PROCESS),
    resumeThread: vi.fn(() => 1),
    terminateProcess: vi.fn(() => 1),
    getStdHandle: vi.fn(() => 0n as NativePtr),
    ...overrides,
  }
}

describe('createKillOnCloseJob', () => {
  it('sets the kill-on-close limit so a crashed owner cannot strand the tree', () => {
    const setInformationJobObject = vi.fn(
      (_handle: NativePtr, _class: number, _information: Buffer) => 1,
    )
    const job = createKillOnCloseJob(api({ setInformationJobObject }))
    expect(job).toBe(JOB)
    const call = setInformationJobObject.mock.calls.at(0)
    if (call === undefined) throw new Error('setInformationJobObject was never called')
    const [handle, cls, information] = call
    expect(handle).toBe(JOB)
    expect(cls).toBe(JobObjectExtendedLimitInformation)
    expect(information.readUInt32LE(JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET))
      .toBe(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
  })

  it('reports a Job that could not be created', () => {
    expect(() => createKillOnCloseJob(api({ createJobObjectW: vi.fn(() => 0n as NativePtr) })))
      .toThrow(Win32Error)
  })

  it('closes the Job when the limit cannot be applied', () => {
    const closeHandle = vi.fn(() => 1)
    expect(() => createKillOnCloseJob(api({ setInformationJobObject: vi.fn(() => 0), closeHandle })))
      .toThrow(Win32Error)
    expect(closeHandle).toHaveBeenCalledWith(JOB)
  })
})

describe('attachProcessToJob', () => {
  it('opens the process with exactly the rights assignment needs and closes it after', () => {
    const openProcess = vi.fn(() => PROCESS)
    const assignProcessToJobObject = vi.fn(() => 1)
    const closeHandle = vi.fn(() => 1)

    attachProcessToJob(api({ openProcess, assignProcessToJobObject, closeHandle }), JOB, 4242)

    expect(openProcess).toHaveBeenCalledWith(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, 4242)
    expect(assignProcessToJobObject).toHaveBeenCalledWith(JOB, PROCESS)
    expect(closeHandle).toHaveBeenCalledWith(PROCESS)
  })

  it('reports a process it cannot open', () => {
    expect(() =>{  attachProcessToJob(api({ openProcess: vi.fn(() => 0n as NativePtr) }), JOB, 7) })
      .toThrow(/OpenProcess/)
  })

  it('closes the process handle even when the assignment is refused', () => {
    const closeHandle = vi.fn(() => 1)
    expect(() =>{  attachProcessToJob(api({ assignProcessToJobObject: vi.fn(() => 0), closeHandle }), JOB, 7) })
      .toThrow(/AssignProcessToJobObject/)
    expect(closeHandle).toHaveBeenCalledWith(PROCESS)
  })
})

describe('terminateJob', () => {
  it('terminates every member with the requested exit code', () => {
    const terminateJobObject = vi.fn(() => 1)
    terminateJob(api({ terminateJobObject }), JOB, 137)
    expect(terminateJobObject).toHaveBeenCalledWith(JOB, 137)
  })

  it('reports a refused termination instead of discarding it', () => {
    expect(() =>{  terminateJob(api({ terminateJobObject: vi.fn(() => 0) }), JOB, 1) })
      .toThrow(/TerminateJobObject/)
  })
})

describe('jobAssignedProcessCount', () => {
  function query(assigned: number, status: number, returnedLength = JOBOBJECT_ID_LIST_OFFSET): Win32ProcessBindings['queryInformationJobObject'] {
    return (_job, cls, information, _length, returned) => {
      expect(cls).toBe(JobObjectBasicProcessIdList)
      information.writeUInt32LE(assigned, 0)
      koffi.encode(returned, 'uint32', returnedLength)
      return status
    }
  }

  it('reads the kernel count of members still running', () => {
    expect(jobAssignedProcessCount(api({ queryInformationJobObject: vi.fn(query(3, 1)) }), JOB)).toBe(3)
    expect(jobAssignedProcessCount(api({ queryInformationJobObject: vi.fn(query(0, 1)) }), JOB)).toBe(0)
  })

  it('accepts ERROR_MORE_DATA, which only means the id list outgrew the buffer', () => {
    const bindings = api({
      queryInformationJobObject: vi.fn(query(9, 0)),
      getLastError: vi.fn(() => ERROR_MORE_DATA),
    })
    expect(jobAssignedProcessCount(bindings, JOB)).toBe(9)
  })

  it('refuses to read counts a failed query never filled', () => {
    expect(jobAssignedProcessCount(api({ queryInformationJobObject: vi.fn(query(4, 1, 0)) }), JOB)).toBe(0)
  })

  it('reports any other query failure', () => {
    const bindings = api({
      queryInformationJobObject: vi.fn(query(0, 0)),
      getLastError: vi.fn(() => 6),
    })
    expect(() => jobAssignedProcessCount(bindings, JOB)).toThrow(/QueryInformationJobObject/)
  })
})
