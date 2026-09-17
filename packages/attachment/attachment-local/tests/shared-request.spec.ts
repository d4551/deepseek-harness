import { getEventListeners } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { SharedRequest } from '../src/shared-request.ts'

it('keeps the final cancelling caller pending until the owned operation settles', async () => {
  const finish = Promise.withResolvers<number>()
  const operation = new SharedRequest(() => finish.promise)
  const controller = new AbortController()
  const reason = new Error('final caller cancelled')
  let returned = false
  const rejected = expect(operation.wait(controller.signal)).rejects.toBe(reason).then(() => { returned = true })
  controller.abort(reason)
  try {
    await setImmediate()
    expect(operation.controller.signal.reason).toBe(reason)
    expect(returned).toBe(false)
  } finally {
    finish.resolve(1)
    await rejected
  }
  expect(returned).toBe(true)
  expect(getEventListeners(controller.signal, 'abort')).toEqual([])
})

it('lets one caller cancel immediately while another retains the shared operation', async () => {
  const finish = Promise.withResolvers<number>()
  let starts = 0
  const operation = new SharedRequest(() => { starts += 1; return finish.promise })
  const first = new AbortController()
  const second = new AbortController()
  const reason = 'cancel one caller'
  const cancelled = expect(operation.wait(first.signal)).rejects.toBe(reason)
  const remaining = operation.wait(second.signal)
  first.abort(reason)
  try {
    await cancelled
    expect(operation.controller.signal.aborted).toBe(false)
    expect(starts).toBe(1)
    expect(getEventListeners(first.signal, 'abort')).toEqual([])
  } finally {
    finish.resolve(2)
    await expect(remaining).resolves.toBe(2)
  }
  expect(getEventListeners(second.signal, 'abort')).toEqual([])
})

it('preserves an operation failure for every remaining caller', async () => {
  const finish = Promise.withResolvers<number>()
  const operation = new SharedRequest(() => finish.promise)
  const controller = new AbortController()
  const failure = new Error('native operation failed')
  const first = expect(operation.wait(controller.signal)).rejects.toBe(failure)
  const second = expect(operation.wait()).rejects.toBe(failure)
  finish.reject(failure)
  await Promise.all([first, second])
  expect(getEventListeners(controller.signal, 'abort')).toEqual([])
  expect(operation.controller.signal.aborted).toBe(false)
})

it('rejects an already cancelled waiter without cancelling an existing owner', async () => {
  const finish = Promise.withResolvers<number>()
  const operation = new SharedRequest(() => finish.promise)
  const remaining = operation.wait()
  const reason = new Error('already cancelled')
  await expect(operation.wait(AbortSignal.abort(reason))).rejects.toBe(reason)
  expect(operation.controller.signal.aborted).toBe(false)
  finish.resolve(3)
  await expect(remaining).resolves.toBe(3)
})

it('settles final cancellation when the owned operation also rejects', async () => {
  const finish = Promise.withResolvers<number>()
  const operation = new SharedRequest(() => finish.promise)
  const controller = new AbortController()
  const reason = 'cancelled'
  const rejected = expect(operation.wait(controller.signal)).rejects.toBe(reason)
  controller.abort(reason)
  finish.reject(new Error('operation observed cancellation'))
  await rejected
  expect(getEventListeners(controller.signal, 'abort')).toEqual([])
})
