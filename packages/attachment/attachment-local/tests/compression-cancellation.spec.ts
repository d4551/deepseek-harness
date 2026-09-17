import { getEventListeners } from 'node:events'
import { expect, it } from 'vitest'
import { CompressionLimiter } from '../src/compression-limiter.ts'
import { encodeFirstWithinLimit } from '../src/encoding.ts'

it('cancels a queued task before the occupied slot is released', async () => {
  const limiter = new CompressionLimiter(1)
  const release = Promise.withResolvers<string>()
  const active = limiter.run(() => release.promise)
  const controller = new AbortController()
  const reason = new Error('queue cancelled')
  let executed = false
  const queued = limiter.run(async () => {
    executed = true
    return 'cancelled task'
  }, controller.signal)
  const rejected = expect(queued).rejects.toBe(reason)
  const next = limiter.run(async () => 'next task')
  controller.abort(reason)
  try {
    await rejected
    expect(executed).toBe(false)
    expect(getEventListeners(controller.signal, 'abort')).toEqual([])
  } finally {
    release.resolve('active task')
    await active
    await expect(next).resolves.toBe('next task')
  }
  expect(executed).toBe(false)
})

it('holds an active cancelled slot until the operation settles', async () => {
  const limiter = new CompressionLimiter(1)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<number>()
  const controller = new AbortController()
  const reason = new Error('active task cancelled')
  const order: string[] = []
  const active = limiter.run(async () => {
    order.push('active')
    entered.resolve(undefined)
    const value = await release.promise
    order.push('settled')
    return value
  }, controller.signal)
  const rejected = expect(active).rejects.toBe(reason)
  const next = limiter.run(async () => { order.push('next'); return 2 })
  await entered.promise
  controller.abort(reason)
  await Promise.resolve()
  expect(order).toEqual(['active'])
  release.resolve(1)
  await rejected
  await expect(next).resolves.toBe(2)
  expect(order).toEqual(['active', 'settled', 'next'])
  expect(getEventListeners(controller.signal, 'abort')).toEqual([])
})

it('rejects an already aborted signal without calling the operation', async () => {
  const limiter = new CompressionLimiter(1)
  const reason = new Error('already cancelled')
  let executed = false
  await expect(limiter.run(async () => {
    executed = true
    return 1
  }, AbortSignal.abort(reason))).rejects.toBe(reason)
  expect(executed).toBe(false)
  await expect(limiter.run(async () => 2)).resolves.toBe(2)
})

it('preserves a primitive native cancellation reason and releases the task slot', async () => {
  const limiter = new CompressionLimiter(1)
  const reason = 'native operation cancelled'
  const operationSignal = AbortSignal.abort(reason)
  const failed = limiter.run(async () => {
    operationSignal.throwIfAborted()
    return 1
  })
  const next = limiter.run(async () => 2)
  await expect(failed).rejects.toBe(reason)
  await expect(next).resolves.toBe(2)
})

it('does not start another encoding candidate after cancellation', async () => {
  const controller = new AbortController()
  const reason = new Error('encoding cancelled')
  const completed: number[] = []
  const encoding = encodeFirstWithinLimit([
    async () => {
      completed.push(1)
      controller.abort(reason)
      return { data: new Uint8Array(12) }
    },
    async () => {
      completed.push(2)
      return { data: new Uint8Array(8) }
    },
  ], 10, controller.signal)
  await expect(encoding).rejects.toBe(reason)
  expect(completed).toEqual([1])
})
