import { getEventListeners } from 'node:events'
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

    const reason = new Error('caller went away')
    controller.abort(reason)
    await expect(cancelled).rejects.toBe(reason)
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 1 })

    held()
    const survivorRelease = await survivor
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    survivorRelease()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('normalizes non-Error reasons before and during a queued wait', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const alreadyAborted = new AbortController()
    alreadyAborted.abort('caller-left')
    await expect(gate.acquire(alreadyAborted.signal)).rejects.toThrow('caller-left')

    const laterAborted = new AbortController()
    const cancelled = gate.acquire(laterAborted.signal)
    await drain()

    laterAborted.abort('caller-left')
    await expect(cancelled).rejects.toThrow('caller-left')
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })

    held()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('does not execute conversion code supplied as an abort reason', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const controller = new AbortController()
    const reason = {
      toString: () => { throw new Error('abort reason conversion executed') },
    }
    controller.abort(reason)

    await expect(gate.acquire(controller.signal)).rejects.toMatchObject({
      message: 'capacity gate wait aborted',
      cause: reason,
    })
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    held()
  })

  it('detaches abort listeners after either granting or closing a queued wait', async () => {
    const grantedGate = new CapacityGate(1)
    const grantedHeld = await grantedGate.acquire()
    const grantedController = new AbortController()
    const granted = grantedGate.acquire(grantedController.signal)
    await drain()
    expect(getEventListeners(grantedController.signal, 'abort')).toHaveLength(1)

    grantedHeld()
    const grantedRelease = await granted
    expect(getEventListeners(grantedController.signal, 'abort')).toHaveLength(0)
    grantedRelease()

    const closedGate = new CapacityGate(1)
    const closedHeld = await closedGate.acquire()
    const closedController = new AbortController()
    const closed = closedGate.acquire(closedController.signal)
    const closedOutcome = Promise.allSettled([closed])
    await drain()
    expect(getEventListeners(closedController.signal, 'abort')).toHaveLength(1)

    const closure = new Error('holder disposed')
    closedGate.close(closure)
    expect(await closedOutcome).toEqual([{ status: 'rejected', reason: closure }])
    expect(getEventListeners(closedController.signal, 'abort')).toHaveLength(0)
    closedHeld()
  })

  it('hands a slot straight on when the grant and the abort land in the same tick', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const controller = new AbortController()
    const racing = gate.acquire(controller.signal)
    const survivor = gate.acquire()
    const later = gate.acquire()
    await drain()

    // The release grants the head waiter synchronously; the abort lands before
    // its continuation runs, so the granted slot must reach the next waiter.
    held()
    controller.abort(new Error('cancelled after the grant'))
    await expect(racing).rejects.toThrow('cancelled after the grant')
    const survivorRelease = await survivor
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 1 })
    survivorRelease()
    const laterRelease = await later
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    laterRelease()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('removes an aborted waiter from the middle without disturbing FIFO order', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const first = gate.acquire()
    const controller = new AbortController()
    const cancelled = gate.acquire(controller.signal)
    const last = gate.acquire()
    await drain()

    controller.abort(new Error('middle waiter cancelled'))
    await expect(cancelled).rejects.toThrow('middle waiter cancelled')
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 2 })

    held()
    const firstRelease = await first
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 1 })
    firstRelease()
    const lastRelease = await last
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })
    lastRelease()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })

  it('fails every queued waiter on close and refuses later acquisitions', async () => {
    const gate = new CapacityGate(1)
    const held = await gate.acquire()
    const queued = [gate.acquire(), gate.acquire()]
    const outcomes = Promise.allSettled(queued)
    await drain()
    expect(gate.snapshot().waiting).toBe(2)

    const closure = new Error('holder disposed')
    gate.close(closure)
    gate.close(new Error('a later closure never replaces the first'))
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: closure },
      { status: 'rejected', reason: closure },
    ])
    expect(gate.snapshot()).toEqual({ limit: 1, active: 1, waiting: 0 })

    await expect(gate.acquire()).rejects.toBe(closure)
    // A granted holder still releases safely after closure.
    held()
    expect(gate.snapshot()).toEqual({ limit: 1, active: 0, waiting: 0 })
  })
})
