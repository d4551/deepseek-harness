import { setTimeout } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { waitForPersistence } from '../src/persistence-deadline.ts'

it('rechecks missing durable state and resolves when it arrives within the deadline', async () => {
  let reads = 0
  await waitForPersistence(() => ++reads === 2, new Error('state absent'), 1000, 1)
  expect(reads).toBe(2)
})

it('reports the requested durable state when the observation budget expires', async () => {
  const failure = new Error('state absent within 10ms')
  await expect(waitForPersistence(() => false, failure, 10, 1)).rejects.toBe(failure)
})

it('drains a pending read and rejects its late successful observation', async () => {
  const read = Promise.withResolvers<boolean>()
  const failure = new Error('state absent within 10ms')
  let settled = false
  const outcome = Promise.allSettled([waitForPersistence(() => read.promise, failure, 10, 1)])
    .then((results) => { settled = true; return results })
  await setTimeout(20)
  expect(settled).toBe(false)
  read.resolve(true)
  expect(await outcome).toEqual([{ status: 'rejected', reason: failure }])
})

it('propagates a failed read without replacing it with a deadline error', async () => {
  const failure = new Error('persistence read failed')
  await expect(waitForPersistence(() => Promise.reject(failure), new Error('state absent'), 1000, 1))
    .rejects.toBe(failure)
})
