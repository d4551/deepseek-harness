import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JsonRpcLineTransport } from '../src/transport.ts'

describe('JSON-RPC notification failure ownership', () => {
  it.each(['throw', 'reject'])('contains a %s in a real Node process and reports the exact failure', (mode) => {
    const run = spawnSync(process.execPath, [
      '--unhandled-rejections=strict',
      '--import', import.meta.resolve('tsx'),
      fileURLToPath(new URL('./notification-failure-process.ts', import.meta.url)),
      mode,
    ], { encoding: 'utf8', timeout: 10_000 })
    expect(run.error).toBeUndefined()
    expect(run.signal).toBeNull()
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({
      closed: `notification ${mode}`,
      pending: `notification ${mode}`,
      frames: 1,
    })
  })

  it('retains an unrequested notification failure and denies all later traffic', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const failure = new Error('invalid notification')
    transport.onNotification(() => { throw failure })
    transport.start()
    input.write('{"jsonrpc":"2.0","method":"fail"}\n')
    expect(await transport.closed).toBe(failure)
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
    expect(output.read()).toBeNull()
    await expect(transport.request('later', {})).rejects.toBe(failure)
    await expect(transport.flush()).rejects.toBe(failure)
    expect(() => { transport.notify('later') }).toThrow(failure)
    expect(() => { transport.start() }).toThrow(failure)
    transport.close()
    expect(await transport.closed).toBe(failure)
    expect(input.destroyed).toBe(false)
    expect(output.destroyed).toBe(false)
  })

  it('rejects every pending request and releases their abort listeners', async () => {
    const input = new PassThrough()
    const transport = new JsonRpcLineTransport(input, new PassThrough())
    const failure = new Error('async notification failure')
    const release = Promise.withResolvers<undefined>()
    transport.onNotification(async () => { await release.promise; throw failure })
    transport.start()
    const controllers = [new AbortController(), new AbortController()]
    const requests = controllers.map(controller => transport.request('pending', {}, controller.signal))
    const outcomes = Promise.allSettled(requests)
    input.write('{"jsonrpc":"2.0","method":"fail"}\n')
    expect(controllers.map(controller => getEventListeners(controller.signal, 'abort').length)).toEqual([1, 1])
    release.resolve(undefined)
    expect(await outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    expect(controllers.map(controller => getEventListeners(controller.signal, 'abort').length)).toEqual([0, 0])
    expect(await transport.closed).toBe(failure)
  })

  it('awaits successful asynchronous notifications without blocking response processing', async () => {
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const a = new JsonRpcLineTransport(bToA, aToB)
    const b = new JsonRpcLineTransport(aToB, bToA)
    const completion = Promise.withResolvers<object>()
    a.onRequest(async (method, params) => ({ method, params }))
    b.onNotification(async (method, params) => {
      completion.resolve({ method, params, response: await b.request('notification-read', params) })
    })
    a.start()
    b.start()
    a.notify('async-notification', { sequence: 1 })
    expect(await completion.promise).toEqual({
      method: 'async-notification',
      params: { sequence: 1 },
      response: { method: 'notification-read', params: { sequence: 1 } },
    })
    expect(await b.request('next', {})).toEqual({ method: 'next', params: {} })
    a.close()
    b.close()
  })

  it('reports a failed response write through the same terminal outcome', async () => {
    const input = new PassThrough()
    const failure = new Error('response write failed')
    const output = new Writable({ write() { throw failure } })
    const transport = new JsonRpcLineTransport(input, output)
    transport.onRequest(async () => ({ accepted: true }))
    transport.start()
    input.write('{"jsonrpc":"2.0","id":"incoming","method":"read"}\n')
    expect(await transport.closed).toBe(failure)
    await setImmediate()
    expect(input.listenerCount('data')).toBe(0)
  })

  it('owns asynchronous output errors and rejects pending requests with that error', async () => {
    const failure = new Error('output callback failed')
    const input = new PassThrough()
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(failure) } })
    const transport = new JsonRpcLineTransport(input, output)
    transport.start()
    const request = transport.request('send', {})
    await expect(request).rejects.toBe(failure)
    expect(await transport.closed).toBe(failure)
    expect(input.listenerCount('data')).toBe(0)
  })

  it('retains notification rejection after EOF and joins every dispatched frame', async () => {
    const input = new PassThrough()
    const transport = new JsonRpcLineTransport(input, new PassThrough())
    const release = Promise.withResolvers<undefined>()
    const failure = new Error('notification rejected after EOF')
    const entered = Promise.withResolvers<undefined>()
    transport.onNotification(async () => {
      entered.resolve(undefined)
      await release.promise
      throw failure
    })
    transport.start()
    const request = transport.request('pending-at-EOF', {})
    const requestOutcome = Promise.allSettled([request])
    input.end('{"jsonrpc":"2.0","method":"tail"}\n')
    await entered.promise
    const [pending] = await requestOutcome
    expect(pending.status).toBe('rejected')
    if (pending.status !== 'rejected') throw new Error('EOF did not reject the pending request')
    expect(pending.reason).toEqual(new Error('JSON-RPC input closed'))
    release.resolve(undefined)
    const closed = await transport.closed
    expect(closed).toBeInstanceOf(AggregateError)
    if (!(closed instanceof AggregateError)) throw new Error('late frame failure was not retained')
    expect(closed.errors).toEqual([pending.reason, failure])
    expect(closed.cause).toBe(pending.reason)
  })

  it('retains every concurrent notification failure while preserving the first request failure', async () => {
    const input = new PassThrough()
    const transport = new JsonRpcLineTransport(input, new PassThrough())
    const first = Promise.withResolvers<undefined>()
    const second = Promise.withResolvers<undefined>()
    const firstFailure = new Error('first notification')
    const secondFailure = new Error('second notification')
    transport.onNotification(async (method) => {
      if (method === 'first') {
        await first.promise
        throw firstFailure
      }
      await second.promise
      throw secondFailure
    })
    transport.start()
    const pending = transport.request('pending', {})
    const outcome = Promise.allSettled([pending])
    input.write('{"jsonrpc":"2.0","method":"first"}\n{"jsonrpc":"2.0","method":"second"}\n')
    first.resolve(undefined)
    expect(await outcome).toEqual([{ status: 'rejected', reason: firstFailure }])
    second.resolve(undefined)
    const closed = await transport.closed
    expect(closed).toBeInstanceOf(AggregateError)
    if (!(closed instanceof AggregateError)) throw new Error('concurrent frame failure was not retained')
    expect(closed.errors).toEqual([firstFailure, secondFailure])
  })
})
