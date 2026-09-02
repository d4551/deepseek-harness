/**
 * Job-object ownership for processes this library did not create.
 *
 * Windows has no process group and no signal delivery, so "terminate this tree"
 * and "is this tree still alive" are not questions a pid can answer: a
 * grandchild reparents to nothing and outlives every probe aimed at its
 * parent. A Job object is the kernel's own answer — membership is inherited by
 * descendants, `TerminateJobObject` stops every member at once, and the
 * assigned-process count is an authoritative liveness reading rather than an
 * inference from the direct child.
 *
 * The primitives here operate on an ALREADY-CREATED process, so a runtime that
 * spawns through Node (`child_process.spawn`) can still own its tree. Creating
 * the process inside the Job instead is `spawnInheritedJobProcess`, which needs
 * a restricted token this path does not have.
 * @module @deepseek-ai/dsh-win32-process/job
 */

import * as abi from './abi.ts'
import { allocUint32, decodeUint32, extendWin32ProcessBindings, isNullPtr, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32ProcessBindings } from './ffi.ts'

/**
 * Create a Job whose members all die when its last handle closes.
 *
 * The limit is what makes the Job a containment guarantee rather than a
 * bookkeeping device: if the owning process crashes, the kernel closes its
 * handles and the whole tree goes with them, so a hard-killed harness cannot
 * strand a spawned shell.
 * @param api - active binding table.
 * @returns the caller-owned Job handle.
 * @throws Win32Error when the Job cannot be created or limited.
 */
export function createKillOnCloseJob(api: Win32ProcessBindings): NativePtr {
  const job = api.createJobObjectW(null, null)
  if (isNullPtr(job)) throwLastError(api, 'CreateJobObjectW')
  const information = Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE)
  information.writeUInt32LE(
    abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET,
  )
  if (api.setInformationJobObject(
    job,
    abi.JobObjectExtendedLimitInformation,
    information,
    information.length,
  ) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(job)
    throwWin32(api, 'SetInformationJobObject', win32Code)
  }
  return job
}

/**
 * Assign an already-running process to `job`, so it and every descendant it
 * creates from now on belong to the Job.
 *
 * Assignment is not retroactive: a grandchild that already exists stays
 * outside. Callers that need the whole tree covered assign the leader before
 * it can spawn anything, or accept that pre-existing descendants are not
 * members.
 * @param api - active binding table.
 * @param job - the Job the process joins.
 * @param pid - the process id to assign.
 * @throws Win32Error when the process cannot be opened or assigned.
 */
export function attachProcessToJob(api: Win32ProcessBindings, job: NativePtr, pid: number): void {
  const process = api.openProcess(abi.PROCESS_SET_QUOTA | abi.PROCESS_TERMINATE, 0, pid)
  if (isNullPtr(process)) throwLastError(api, 'OpenProcess', `pid ${String(pid)}`)
  const assigned = api.assignProcessToJobObject(job, process)
  const win32Code = assigned === 0 ? api.getLastError() : 0
  // The Job holds its own reference to the process once assigned; this handle
  // exists only for the assignment, and leaking it would keep the process
  // object alive after exit.
  api.closeHandle(process)
  if (assigned === 0) throwWin32(api, 'AssignProcessToJobObject', win32Code, `pid ${String(pid)}`)
}

/**
 * Terminate every process still assigned to `job`.
 * @param api - active binding table.
 * @param job - the Job whose members are stopped.
 * @param exitCode - exit code reported for each terminated member.
 * @throws Win32Error when the kernel refuses the request.
 */
export function terminateJob(api: Win32ProcessBindings, job: NativePtr, exitCode: number): void {
  if (api.terminateJobObject(job, exitCode) === 0) throwLastError(api, 'TerminateJobObject')
}

/**
 * How many processes the kernel still counts as members of `job`.
 *
 * This is the whole-tree liveness reading Windows otherwise denies: it stays
 * non-zero while any descendant runs, including one whose parent already
 * exited. `ERROR_MORE_DATA` is expected and harmless — the counts are filled
 * before the id list overflows the buffer, and only the count is read.
 * @param api - active binding table.
 * @param job - the Job to query.
 * @returns the number of assigned processes.
 * @throws Win32Error when the query fails for any other reason.
 */
export function jobAssignedProcessCount(api: Win32ProcessBindings, job: NativePtr): number {
  const record = Buffer.alloc(abi.JOBOBJECT_ID_LIST_OFFSET + abi.JOBOBJECT_ID_SIZE)
  const returned = allocUint32()
  const queried = api.queryInformationJobObject(
    job,
    abi.JobObjectBasicProcessIdList,
    record,
    record.length,
    returned,
  )
  if (queried === 0) {
    const win32Code = api.getLastError()
    if (win32Code !== abi.ERROR_MORE_DATA) throwWin32(api, 'QueryInformationJobObject', win32Code)
  }
  // Reading the returned length keeps the out-parameter contract honest: a
  // query that reported nothing cannot be trusted to have filled the counts.
  if (decodeUint32(returned) < abi.JOBOBJECT_ID_LIST_OFFSET) return 0
  return record.readUInt32LE(abi.JOBOBJECT_ASSIGNED_PROCESSES_OFFSET)
}

let cached: Win32ProcessBindings | undefined

/* v8 ignore start -- loads Windows libraries; every operation above takes an injected table. */
/**
 * The shared process binding table, loaded on first use. Windows-only: it
 * opens kernel32 and advapi32.
 * @returns the process bindings the Job operations here run against.
 */
export function win32ProcessBindings(): Win32ProcessBindings {
  cached ??= extendWin32ProcessBindings(() => ({}))
  return cached
}
/* v8 ignore stop */
