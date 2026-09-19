import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorMessage, TeamError } from '../src/error.ts'
import { TeamRuntimeLifecycle } from '../src/lifecycle.ts'

/** Values a Promise reject arm from runtime settlement may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

const leftoverRejects: readonly Thrown[] = [
  'leftover string',
  7,
  false,
  1n,
  Symbol('leftover'),
  { leftover: true },
  null,
  undefined,
]

afterEach(() => {
  vi.useRealTimers()
})

describe('TeamRuntimeLifecycle leftover Thrown settlement', () => {
  it('retains leftover Thrown rejects and drops only runtime cancellation', async () => {
    const open = new TeamRuntimeLifecycle(100)
    expect(open.disposed).toBe(false)
    expect(open.signal.aborted).toBe(false)
    expect(open.reason).toBeUndefined()
    const emptyFailures: unknown[] = []
    await open.settle([], emptyFailures)
    expect(emptyFailures).toEqual([])
    const leftoverError = new Error('leftover error', { cause: 'leftover cause' })
    const openFailures: unknown[] = []
    await open.settle([
      ...leftoverRejects.map(reason => Promise.reject(reason)),
      Promise.reject(leftoverError),
    ], openFailures)
    expect(openFailures).toEqual([...leftoverRejects, leftoverError])

    const lifecycle = new TeamRuntimeLifecycle(100)
    lifecycle.close()
    expect(lifecycle.disposed).toBe(true)
    const failures: unknown[] = []
    await lifecycle.settle([
      Promise.reject(lifecycle.reason),
      Promise.reject(new Error('wrapped cancellation', { cause: lifecycle.reason })),
      Promise.reject(new TeamError('translated cancellation', 'TEAM_DISPOSED')),
      Promise.reject({ kind: 'user' }),
    ], failures)
    expect(failures).toEqual([{ kind: 'user' }])
    expect(errorMessage({ kind: 'user' })).toBe("{ kind: 'user' }")

    const nested = new Error('nested ordinary', { cause: new Error('inner ordinary') })
    const cyclic = new Error('unrelated cyclic failure')
    cyclic.cause = cyclic
    await lifecycle.settle([Promise.reject(nested), Promise.reject(cyclic)], failures)
    expect(failures).toEqual([{ kind: 'user' }, nested, cyclic])
  })

  it('claims leftover withTimeout rejects as Thrown and clears the disposal timer', async () => {
    vi.useFakeTimers()
    const success = new TeamRuntimeLifecycle(50)
    await expect(success.withTimeout(Promise.resolve('settled'))).resolves.toBe('settled')
    await vi.advanceTimersByTimeAsync(80)

    for (const reason of leftoverRejects) {
      const lifecycle = new TeamRuntimeLifecycle(50)
      await expect(lifecycle.withTimeout(Promise.reject(reason))).rejects.toBe(reason)
      await vi.advanceTimersByTimeAsync(80)
    }

    const timed = new TeamRuntimeLifecycle(20)
    const overdueFailure = timed.withTimeout(new Promise<never>(() => {})).then(
      undefined,
      (error: Thrown) => error,
    )
    await vi.advanceTimersByTimeAsync(20)
    await expect(overdueFailure).resolves.toMatchObject({
      code: 'TEAM_DISPOSAL_TIMEOUT',
      message: 'Agent Teams runtime disposal exceeded 20ms',
    })

    const bounded = new TeamRuntimeLifecycle(20)
    const failures: unknown[] = []
    const hung = bounded.settle([new Promise<never>(() => {})], failures)
    await vi.advanceTimersByTimeAsync(20)
    await hung
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      code: 'TEAM_DISPOSAL_TIMEOUT',
      message: 'Agent Teams runtime disposal exceeded 20ms',
    })
  })
})
