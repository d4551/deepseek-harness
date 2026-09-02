import { describe, expect, it } from 'vitest'
import { CapacityGate } from '../src/index.ts'
import type { CapacityRelease } from '../src/index.ts'

/** Let every already-resolved continuation run before observing gate state. */
function drain(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

describe('CapacityGate', () => {
  it('rejects a limit that is not a positive safe integer', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new CapacityGate(limit)).toThrow(/positive safe integer/)
    }
  })

  it('grants up to the limit immediately and queues the rest', async () => {
    const gate = new CapacityGate(2)
    const first = await gate.acquire()
    const second = await gate.acquire()
    expect(gate.snapshot()).toEqual({ limit: 2, active: 2, waiting: 0 })

    let thirdGranted = false
    const third = gate.acquire().then((release) => {
      thirdGranted = true
      return release
    })
    await drain()
    expect(thirdGranted).toBe(false)
    expect(gate.snapshot()).toEqual({ limit: 2, active: 2, waiting: 1 })

    first()
    const thirdRelease = await third
    expect(gate.snapshot()).toEqual({ limit: 2, active: 2, waiting: 0 })
    second()
    thirdRelease()
    expect(gate.snapshot()).toEqual({ limit: 2, active: 0, waiting: 0 })
  })

  it('admits waiters in arrival order', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const admitted: string[] = []
    const releases: CapacityRelease[] = []
    const queued = ['a', 'b', 'c'].map(async (label) => {
      const release = await gate.acquire()
      admitted.push(label)
      releases.push(release)
    })
    await drain()
    expect(gate.snapshot().waiting).toBe(3)

    held()
    await drain()
    expect(admitted).toEqual(['a'])
    releases[0]!()
    await drain()
    expect(admitted).toEqual(['a', 'b'])
    releases[1]!()
    await Promise.all(queued)
    expect(admitted).toEqual(['a', 'b', 'c'])
    releases[2]!()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('takes a free slot synchronously and refuses without waiting once full or closed', async () => {
    const gate = new CapacityGate(1)
    const immediate = gate.tryAcquire()
    expect(immediate).toBeTypeOf('function')
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    expect(gate.tryAcquire()).toBeUndefined()

    immediate?.()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
    gate.close(new Error('holder disposed'))
    expect(gate.tryAcquire()).toBeUndefined()
  })

  it('hands a synchronously taken slot to the next waiter on release', async () => {
    const gate = new CapacityGate(1)
    const immediate = gate.tryAcquire()
    const queued = gate.acquire()
    await drain()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 1 })

    immediate?.()
    const release = await queued
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    release()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('releases once no matter how many times a holder releases', async () => {
    const gate = new CapacityGate(2)
    const waited = await gate.acquire()
    const immediate = gate.tryAcquire()
    for (const release of [waited, immediate]) {
      release?.()
      release?.()
      release?.()
    }
    expect(gate.snapshot()).toEqual({ limit: 2, active: 0, waiting: 0 })
  })

  it('grants a free slot without reading the signal, and refuses an aborted caller once full', async () => {
    const gate = new CapacityGate(1)
    const controller = new AbortController()
    controller.abort(new Error('gone before asking'))

    // Below the bound the gate is transparent: the holder keeps its own
    // pre-flight cancellation rule instead of inheriting the gate's.
    const release = await gate.acquire(controller.signal)
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })

    await expect(gate.acquire(controller.signal)).rejects.toThrow('gone before asking')
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    release()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('rejects a queued waiter on abort and never gives it a slot', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const controller = new AbortController()
    const cancelled = gate.acquire(controller.signal)
    const survivor = gate.acquire()
    await drain()
    expect(gate.snapshot().waiting).toBe(2)

    controller.abort(new Error('caller went away'))
    await expect(cancelled).rejects.toThrow('caller went away')
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 1 })

    held()
    const survivorRelease = await survivor
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    survivorRelease()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('hands a slot straight on when the grant and the abort land in the same tick', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const controller = new AbortController()
    const racing = gate.acquire(controller.signal)
    const survivor = gate.acquire()
    await drain()

    // The release grants the head waiter synchronously; the abort lands before
    // its continuation runs, so the granted slot must reach the next waiter.
    held()
    controller.abort(new Error('cancelled after the grant'))
    await expect(racing).rejects.toThrow('cancelled after the grant')
    const survivorRelease = await survivor
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    survivorRelease()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('fails every queued waiter on close and refuses later acquisitions', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const queued = [gate.acquire(), gate.acquire()]
    await drain()
    expect(gate.snapshot().waiting).toBe(2)

    gate.close(new Error('holder disposed'))
    gate.close(new Error('a later closure never replaces the first'))
    for (const waiter of queued) await expect(waiter).rejects.toThrow('holder disposed')
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })

    await expect(gate.acquire()).rejects.toThrow('holder disposed')
    // A granted holder still releases safely after closure.
    held()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })
})
