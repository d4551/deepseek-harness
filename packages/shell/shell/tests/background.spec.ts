/**
 * The shell tools' shared background-handle adaptation: how a settled
 * `ShellProcess` maps onto the generic task-outcome vocabulary `ctx.jobs`
 * records.
 */

import { describe, expect, it } from 'vitest'
import { processOutcome } from '../src/background.ts'
import type { ShellProcess } from '../src/types.ts'

function settled(over: Partial<ShellProcess>): ShellProcess {
  return {
    status: 'completed',
    exitCode: 0,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => false,
    ...over,
  }
}

describe('processOutcome', () => {
  it('maps a signal-killed process to killed with the signal detail', () => {
    expect(processOutcome(settled({ status: 'killed', signal: 'SIGTERM' })))
      .toEqual({ status: 'killed', detail: 'signal: SIGTERM' })
  })

  it('maps a killed process without a recorded signal (kill raced exit / spawn failure)', () => {
    expect(processOutcome(settled({ status: 'killed', exitCode: null })))
      .toEqual({ status: 'killed', detail: 'killed before exit' })
  })

  it('maps a completed process to its exit code', () => {
    expect(processOutcome(settled({ exitCode: 3 })))
      .toEqual({ status: 'completed', detail: 'exit code: 3' })
  })

  it('defensively reads a null exit code as 0 (handle shapes from other executors)', () => {
    expect(processOutcome(settled({ exitCode: null })))
      .toEqual({ status: 'completed', detail: 'exit code: 0' })
  })
})
