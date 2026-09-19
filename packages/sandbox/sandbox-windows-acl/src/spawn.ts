/** Restricted-token adapters over the shared Win32 process owner. */

import {
  spawnInheritedJobProcess,
  spawnPipedProcess,
  waitForProcessExit,
} from '@deepseek-ai/dsh-win32-process'
import type {
  NativePtr,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from '@deepseek-ai/dsh-win32-process'
import type { Win32Bindings } from './ffi.ts'

export { drainPipe } from '@deepseek-ai/dsh-win32-process'

/** Restricted-token child with piped stdio resources. */
export interface SpawnedNative extends SpawnedPipedProcess {}
/** Restricted-token child assigned to a kill-on-close Job. */
export interface SpawnedInherited extends SpawnedJobProcess {}

/**
 * Spawn a restricted-token child with piped stdout/stderr.
 * @param api - ACL/token binding table.
 * @param token - restricted primary token.
 * @param options - command, args, and working directory.
 * @returns process and caller-owned pipe handles.
 */
export function spawnSandboxed(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedNative {
  return spawnPipedProcess(api, { ...options, token })
}

/**
 * Spawn a restricted-token child in a kill-on-close Job with inherited stdio.
 * @param api - ACL/token binding table.
 * @param token - restricted primary token.
 * @param options - command, args, and working directory.
 * @returns process and Job handles after assignment and resume.
 */
export function spawnSandboxedInherited(
  api: Win32Bindings,
  token: NativePtr,
  options: { command: string; args: readonly string[]; cwd: string },
): SpawnedInherited {
  return spawnInheritedJobProcess(api, { ...options, token })
}

/**
 * Wait for a restricted child and close its process handle.
 * @param api - ACL/token binding table.
 * @param process - caller-owned process handle.
 * @returns direct process exit code.
 */
export function waitForExit(api: Win32Bindings, process: NativePtr): number {
  return waitForProcessExit(api, process)
}

/** Values a Promise reject arm may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/** One Promise settlement that keeps a Thrown reject reason. */
type ThrownSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: Thrown }

/**
 * Wait for one Promise without aborting siblings, keeping the Thrown reason.
 * @param pending - the in-flight value.
 * @returns a fulfilled or rejected settlement.
 */
function settleThrown<T>(pending: Promise<T>): Promise<ThrownSettlement<T>> {
  return pending.then(
    value => ({ status: 'fulfilled', value }),
    (error: Thrown) => ({ status: 'rejected', reason: error }),
  )
}

/**
 * Rethrow one wait failure. Errors stay the wait rejection; other Thrown
 * values become a one-member AggregateError.
 * @param error - the Thrown the Promise rejected with.
 */
function throwWaitReason(error: Thrown): never {
  if (error instanceof Error) throw error
  throw new AggregateError([error], 'AclSandbox wait completed with 1 drain or exit failure(s)')
}

/**
 * Drain stdout and stderr, then the exit wait, before surfacing failures.
 * @param stdout - the stdout pipe drain.
 * @param stderr - the stderr pipe drain.
 * @param startExit - starts the child exit wait after both drains have settled.
 * @returns captured stdio and the exit code.
 */
export async function waitPipedChildOutcome(
  stdout: Promise<Buffer>,
  stderr: Promise<Buffer>,
  startExit: () => Promise<number>,
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  const [stdoutOutcome, stderrOutcome] = await Promise.all([
    settleThrown(stdout),
    settleThrown(stderr),
  ])
  const exitOutcome = await settleThrown(startExit())
  if (stdoutOutcome.status === 'rejected' || stderrOutcome.status === 'rejected' || exitOutcome.status === 'rejected') {
    const failures: Thrown[] = []
    if (stdoutOutcome.status === 'rejected') failures.push(stdoutOutcome.reason)
    if (stderrOutcome.status === 'rejected') failures.push(stderrOutcome.reason)
    if (exitOutcome.status === 'rejected') failures.push(exitOutcome.reason)
    for (const failure of failures) {
      if (failures.length === 1) throwWaitReason(failure)
    }
    throw new AggregateError(failures, `AclSandbox wait completed with ${failures.length} drain or exit failure(s)`)
  }
  return { stdout: stdoutOutcome.value, stderr: stderrOutcome.value, exitCode: exitOutcome.value }
}
