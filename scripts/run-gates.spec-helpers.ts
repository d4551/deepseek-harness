import { vi } from 'vitest'
import type { Gate, GateResult } from './run-gates.ts'

export function gate(id: string, options: Partial<Gate> = {}): Gate {
  return {
    id,
    label: id,
    displayCommand: `run ${id}`,
    command: process.execPath,
    args: ['-e', ''],
    ...options,
  }
}

export function resultFor(subject: Gate, status: GateResult['status'] = 'passed'): GateResult {
  return {
    gate: subject,
    status,
    durationMs: 10,
    output: [],
    exitCode: status === 'passed' ? 0 : 1,
    signalCode: null,
  }
}

/**
 * Stubs `npm_execpath` for the duration of `action`. Vitest owns restoration:
 * call sites pair this with `afterEach(() => vi.unstubAllEnvs())` so the stub
 * never crosses a test boundary. `vi.stubEnv(name, undefined)` deletes the
 * variable, matching the unset semantics the gate config reads expect.
 */
export function withBunEntrypoint<T>(action: () => T, entrypoint = '/private/bun'): T {
  vi.stubEnv('npm_execpath', entrypoint)
  return action()
}

export function withEnv<T>(name: string, value: string | undefined, action: () => T): T {
  vi.stubEnv(name, value)
  return action()
}
