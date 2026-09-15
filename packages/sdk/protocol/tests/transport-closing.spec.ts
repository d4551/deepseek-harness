import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonRpcLineTransport } from '../src/transport.ts'

describe('transport closing ownership', () => {
  it('joins a handler that closes synchronously and retains its later rejection', async () => {
    const input = new PassThrough()
    const transport = new JsonRpcLineTransport(input, new PassThrough())
    const pending = Promise.withResolvers<undefined>()
    const failure = new Error('notification rejected after local closure')
    transport.onNotification(async () => {
      transport.close()
      await pending.promise
    })
    let drained = false
    const joined = transport.closed.then((reason) => { drained = true; return reason })
    transport.start()
    input.write('{"jsonrpc":"2.0","method":"close"}\n')
    const closing = await transport.closing
    expect(closing.kind).toBe('local')
    expect(drained).toBe(false)
    pending.reject(failure)
    const reason = await joined
    expect(reason).toBeInstanceOf(AggregateError)
    if (!(reason instanceof AggregateError)) throw new Error('missing combined closure')
    expect(reason.errors).toEqual([closing.reason, failure])
    expect(reason.cause).toBe(closing.reason)
  })

  it('publishes failure before a pending handler drains and retains its later failure', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const pending = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const first = new Error('notification rejected')
    const late = new Error('cancelled handler rejected')
    transport.onNotification(async (method) => {
      if (method === 'pending') {
        entered.resolve(undefined)
        await pending.promise
      } else throw first
    })
    transport.start()
    input.write('{"jsonrpc":"2.0","method":"pending"}\n')
    await entered.promise
    input.write('{"jsonrpc":"2.0","method":"failure"}\n')
    expect(await transport.closing).toEqual({ kind: 'failure', reason: first })
    let drained = false
    const joined = transport.closed.then((reason) => { drained = true; return reason })
    await Promise.resolve()
    expect(drained).toBe(false)
    pending.reject(late)
    const reason = await joined
    expect(reason).toBeInstanceOf(AggregateError)
    if (!(reason instanceof AggregateError)) throw new Error('missing combined closure')
    expect(reason.errors).toEqual([first, late])
    expect(reason.cause).toBe(first)
    expect(input.listenerCount('data')).toBe(0)
    expect(output.listenerCount('error')).toBe(0)
  })

  it('distinguishes an owner close from a peer ending its input', async () => {
    const local = new JsonRpcLineTransport(new PassThrough(), new PassThrough())
    local.close()
    expect((await local.closing).kind).toBe('local')
    expect((await local.closed).message).toBe('JSON-RPC transport closed')
    const input = new PassThrough()
    const ended = new JsonRpcLineTransport(input, new PassThrough())
    ended.start()
    input.end()
    expect((await ended.closing).kind).toBe('input-end')
    expect((await ended.closed).message).toBe('JSON-RPC input closed')
  })
})
