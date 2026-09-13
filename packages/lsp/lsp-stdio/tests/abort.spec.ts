import { describe, expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { abortable } from '../src/abort.ts'

describe('owned LSP cancellation waits', () => {
  it('observes later work rejection after an already-aborted wait', async () => {
    const controller = new AbortController()
    const cancellation = new Error('wait canceled before entry')
    controller.abort(cancellation)
    const work = Promise.withResolvers<undefined>()
    await expect(abortable(work.promise, controller.signal)).rejects.toBe(cancellation)
    work.reject(new Error('owned work failed after cancellation'))
    await new Promise<void>(resolve => setImmediate(resolve))
  })

  it('gives a preexisting abort priority over already-completed work', async () => {
    const controller = new AbortController()
    const cancellation = new Error('wait canceled')
    controller.abort(cancellation)
    await expect(abortable(Promise.resolve('completed'), controller.signal)).rejects.toBe(cancellation)
  })

  it('normalizes a work failure while the signal stays live', async () => {
    const controller = new AbortController()
    const work = (async () => { throw 'work stopped' })()
    await expect(abortable(work, controller.signal)).rejects.toThrow('work stopped')
    expect(controller.signal.aborted).toBe(false)
  })

  it('retires the abort listener after work settles', async () => {
    const controller = new AbortController()
    const work = Promise.withResolvers<string>()
    const waiting = abortable(work.promise, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    work.resolve('completed')
    await expect(waiting).resolves.toBe('completed')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    controller.abort(new Error('after completion'))
    await new Promise<void>(resolve => setImmediate(resolve))
  })
})
