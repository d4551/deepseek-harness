/**
 * Windows whole-tree ownership for a process this provider spawned through
 * Node.
 *
 * Windows has neither process groups nor signals, so a pid answers neither
 * "stop this tree" nor "is this tree still running". `taskkill /T /F` walks the
 * parent links the process table happens to hold at that instant and reports
 * only its own exit status; a grandchild whose parent already exited is not on
 * that walk. A Job object replaces both answers with kernel bookkeeping:
 * descendants inherit membership, one call stops every member, and the
 * assigned-process count is the tree's liveness.
 *
 * The Job carries `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so a harness that dies
 * without running teardown still takes its spawned trees with it when the
 * kernel closes its handles.
 * @module dsh-subprocess-local/windows-job
 */

import { attachProcessToJob, createKillOnCloseJob, jobAssignedProcessCount, terminateJob, win32ProcessBindings } from '@deepseek-ai/dsh-win32-process/job'

/** Exit code reported for members a Job termination stops. */
const JOB_TERMINATION_EXIT_CODE = 1

/** One spawned tree's Job object. Every method reports failure by throwing. */
export interface WindowsProcessJob {
  /** Terminate every process still assigned to the tree. */
  terminate(): void
  /** How many processes the kernel still counts in the tree. */
  liveMemberCount(): number
  /** Close the Job handle; kill-on-close takes any remaining member with it. */
  close(): void
}

/**
 * Create a Job for an already-spawned root process.
 * @param pid - the spawned leader's process id.
 * @returns the tree's Job.
 * @throws Win32Error when the Job cannot be created or the leader cannot join it.
 */
export type WindowsJobFactory = (pid: number) => WindowsProcessJob

/* v8 ignore start -- opens Windows libraries; POSIX lanes inject a Job instead, and the win32-process suite pins each primitive. */
/**
 * Put an already-spawned process, and every descendant it creates from now on,
 * into a kill-on-close Job.
 * @param pid - the spawned leader's process id.
 * @returns the tree's Job.
 * @throws Win32Error when the Job cannot be created or the leader cannot join it.
 */
export function createWindowsProcessJob(pid: number): WindowsProcessJob {
  const api = win32ProcessBindings()
  const job = createKillOnCloseJob(api)
  try {
    attachProcessToJob(api, job, pid)
  } catch (error) {
    api.closeHandle(job)
    throw error
  }
  return {
    terminate: () => { terminateJob(api, job, JOB_TERMINATION_EXIT_CODE) },
    liveMemberCount: () => jobAssignedProcessCount(api, job),
    close: () => { api.closeHandle(job) },
  }
}
/* v8 ignore stop */
