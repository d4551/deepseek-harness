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
import type { Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'

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

/**
 * Compose the Job factory over one Win32 binding table.
 *
 * The table is resolved per Job rather than at composition time, so building
 * the factory opens no Windows library and a host that has none reaches the
 * failure only when a Job is actually requested. Every primitive the factory
 * calls comes from the injected table, so its create/attach/terminate/release
 * sequence and its attach-failure cleanup run on any host.
 * @param bindings - resolves the Win32 process bindings the Job runs against.
 * @returns the factory: it creates a kill-on-close Job, joins the leader to
 *   it, and closes the Job again if the leader cannot join.
 */
export function windowsJobFactory(bindings: () => Win32ProcessBindings): WindowsJobFactory {
  return (pid) => {
    const api = bindings()
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
}

/**
 * Put an already-spawned process, and every descendant it creates from now on,
 * into a kill-on-close Job, through the shared Win32 process bindings. Those
 * bindings open Windows libraries on the first Job this factory creates.
 */
export const createWindowsProcessJob: WindowsJobFactory = windowsJobFactory(win32ProcessBindings)
