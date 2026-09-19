import { once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonRpcLineTransport, JsonRpcResponseError } from '../src/index.ts'

/** Values a Promise reject arm from a frame, request handler, write, or abort may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

const leftoverRejects: { label: string; reason: Thrown; text: string }[] = [
  { label: 'string', reason: 'leftover-string', text: 'leftover-string' },
  { label: 'number', reason: 7, text: '7' },
  { label: 'boolean', reason: false, text: 'false' },
  { label: 'bigint', reason: 8n, text: '8' },
  { label: 'symbol', reason: Symbol.for('leftover'), text: 'Symbol(leftover)' },
  { label: 'null', reason: null, text: 'null' },
  { label: 'undefined', reason: undefined, text: 'undefined' },
  { label: 'object', reason: { leftover: true }, text: '[object Object]' },
]

function transportPair() {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const a = new JsonRpcLineTransport(bToA, aToB)
  const b = new JsonRpcLineTransport(aToB, bToA)
  return { a, b, aToB, bToA }
}

describe('JsonRpcLineTransport', () => {
  it('supports bidirectional requests and notifications over newline-delimited JSON-RPC', async () => {
    const { a, b } = transportPair()
    const notifications: Record<string, unknown>[] = []

    a.onRequest(async (method, params) => {
      expect(method).toBe('echo')
      return { echoed: params }
    })
    b.onNotification((method, params) => {
      notifications.push({ method, params })
    })
    a.start()
    b.start()

    const response = await b.request('echo', { value: 42 })
    expect(response).toEqual({ echoed: { value: 42 } })

    a.notify('session.status', { sessionId: 'main', status: 'idle' })
    a.notify('heartbeat')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(notifications).toEqual([
      { method: 'session.status', params: { sessionId: 'main', status: 'idle' } },
      { method: 'heartbeat', params: {} },
    ])

    a.close()
    b.close()
  })

  it('reports JSON-RPC request errors from the remote peer with their wire code', async () => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw new Error('handler boom')
    })
    a.start()
    b.start()

    const failure = await b.request('explode', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: Thrown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ message: 'handler boom', code: -32603, data: undefined })

    a.close()
    b.close()
  })

  it('rejects immediately on a pre-aborted signal without registering pending state', async () => {
    const { b } = transportPair()
    b.start()
    const controller = new AbortController()
    controller.abort(new Error('already gone'))
    const failure = await b.request('never-sent', {}, controller.signal).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: Thrown) => error,
    )
    expect(failure).toMatchObject({ message: 'already gone' })
    expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    b.close()
  })

  it.each(leftoverRejects.filter(row => row.reason !== undefined))(
    'rejects immediately on leftover $label pre-aborted signal',
    async ({ reason, text }) => {
      const { b } = transportPair()
      b.start()
      const controller = new AbortController()
      controller.abort(reason)
      const failure = await b.request('never-sent', {}, controller.signal).then(
        () => { throw new Error('request unexpectedly succeeded') },
        (error: Thrown) => error,
      )
      expect(failure).toMatchObject({ message: `JSON-RPC request aborted: ${text}` })
      expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
      b.close()
    },
  )

  it.each(leftoverRejects.filter(row => row.reason !== undefined))(
    'abandons a pending request on leftover $label abort',
    async ({ reason, text }) => {
      const { b } = transportPair()
      b.start()
      const controller = new AbortController()
      const pending = b.request('never-answered', {}, controller.signal)
      controller.abort(reason)
      const failure = await pending.then(
        () => { throw new Error('request unexpectedly succeeded') },
        (error: Thrown) => error,
      )
      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({ message: `JSON-RPC request aborted: ${text}` })
      expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
      b.close()
    },
  )

  it('preserves Node abort(undefined) as AbortError on the request reject arm', async () => {
    const { b } = transportPair()
    b.start()
    const controller = new AbortController()
    controller.abort(undefined)
    const failure = await b.request('never-sent', {}, controller.signal).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: Thrown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ name: 'AbortError' })
    expect((b as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0)
    b.close()
  })

  it('preserves structured error data from an error response frame', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    const pending = b.request('remote-error-data', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 7, message: 'structured', data: { detail: 'x' } } })}\n`)

    const failure = await pending.then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: Thrown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ code: 7, message: 'structured', data: { detail: 'x' } })

    b.close()
  })

  it.each(leftoverRejects)('stringifies a leftover $label request-handler reject', async ({ reason, text }) => {
    const { a, b } = transportPair()
    a.onRequest(async () => {
      throw reason
    })
    a.start()
    b.start()

    const failure = await b.request('explode-leftover', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: Thrown) => error,
    )
    expect(failure).toBeInstanceOf(JsonRpcResponseError)
    expect(failure).toMatchObject({ message: text, code: -32603 })

    a.close()
    b.close()
  })

  it.each(leftoverRejects)('closes on a leftover $label notification reject', async ({ reason, text }) => {
    const input = new PassThrough()
    const transport = new JsonRpcLineTransport(input, new PassThrough())
    transport.onNotification(() => { throw reason })
    transport.start()
    input.write('{"jsonrpc":"2.0","method":"fail"}\n')
    const closed = await transport.closed
    expect(closed).toBeInstanceOf(Error)
    expect(closed.message).toBe(text)
    await expect(transport.request('later', {})).rejects.toThrow(text)
  })

  it('reports method-not-found when no request handler is installed', async () => {
    const { a, b } = transportPair()
    a.start()
    b.start()

    await expect(b.request('missing', {})).rejects.toThrow('method not found: missing')

    a.close()
    b.close()
  })

  it('normalizes non-object request params and ignores notifications without a handler', async () => {
    const { aToB, bToA, b } = transportPair()
    const seen: Record<string, unknown>[] = []
    b.onRequest(async (method, params) => {
      seen.push({ method, params })
      return { ok: true }
    })
    b.start()

    aToB.write('{"jsonrpc":"2.0","method":"ignored"}\n')
    aToB.write('{"jsonrpc":"2.0","id":7,"method":"array-params","params":[]}\n')
    const chunk = (await once(bToA, 'data'))[0] as Buffer | string

    expect(seen).toEqual([{ method: 'array-params', params: {} }])
    expect(JSON.parse(String(chunk))).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: true } })
    b.close()
  })

  it('ignores malformed frames and accepts notifications without params', async () => {
    const { aToB, b } = transportPair()
    const notifications: Record<string, unknown>[] = []
    b.onNotification((method, params) => {
      notifications.push({ method, params })
    })
    b.start()
    b.start()

    aToB.write('not json\n')
    aToB.write('\n')
    aToB.write('null\n')
    aToB.write('{"jsonrpc":"2.0","params":{}}\n')
    aToB.write('{"jsonrpc":"2.0","method":"tick"}\n')
    aToB.emit('data', '{"jsonrpc":"2.0","method":"string-chunk"}\n')
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([
      { method: 'tick', params: {} },
      { method: 'string-chunk', params: {} },
    ])
    b.close()
  })

  it('preserves multibyte UTF-8 characters split across Buffer chunks', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const notifications: Record<string, unknown>[] = []
    transport.onNotification((method, params) => { notifications.push({ method, params }) })
    transport.start()

    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'message', params: { text: '你好' } })}\n`)
    const character = Buffer.from('你')
    const characterStart = frame.indexOf(character)
    expect(characterStart).toBeGreaterThanOrEqual(0)
    input.write(frame.subarray(0, characterStart + 1))
    input.write(frame.subarray(characterStart + 1))
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(notifications).toEqual([{ method: 'message', params: { text: '你好' } }])
    transport.close()
  })

  it('flush waits for all earlier output writes', async () => {
    const events: string[] = []
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const label = chunk.length === 0 ? 'barrier' : 'frame'
        events.push(`start:${label}`)
        setTimeout(() => {
          events.push(`finish:${label}`)
          callback()
        }, 5)
      },
    })
    const transport = new JsonRpcLineTransport(new PassThrough(), output)

    transport.notify('tick')
    await transport.flush()

    expect(events).toEqual([
      'start:frame',
      'finish:frame',
      'start:barrier',
      'finish:barrier',
    ])
    transport.close()
  })

  it('reports an output callback failure from flush', async () => {
    const output = {
      write(_chunk: string, callback?: (error?: Error) => void) {
        callback?.(new Error('flush failed'))
        return true
      },
    }
    const transport = new JsonRpcLineTransport(new PassThrough(), output as never)

    const failure = await transport.flush().then(
      () => { throw new Error('flush unexpectedly succeeded') },
      (error: Thrown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: 'flush failed' })
  })

  it.each(leftoverRejects.filter(row => Boolean(row.reason)))('rejects flush with a leftover $label write-callback reason', async ({ reason }) => {
    const output = {
      write(_chunk: string, callback?: (error?: Thrown) => void) {
        callback?.(reason)
        return true
      },
    }
    const transport = new JsonRpcLineTransport(new PassThrough(), output as never)

    const failure = await transport.flush().then(
      () => { throw new Error('flush unexpectedly succeeded') },
      (error: Thrown) => error,
    )
    expect(failure).toBe(reason)
  })

  it('rejects pending requests when the input closes', async () => {
    const { aToB, b } = transportPair()
    b.start()

    const pending = b.request('never-replies', {})
    aToB.end()

    await expect(pending).rejects.toThrow('JSON-RPC input closed')
    b.close()
  })

  it('rejects pending requests when the input errors', async () => {
    const { aToB, b } = transportPair()
    b.start()

    const pending = b.request('never-replies', {})
    aToB.emit('error', new Error('input broke'))

    await expect(pending).rejects.toThrow('input broke')
    b.close()
  })

  it('rejects pending requests when the transport closes', async () => {
    const { b } = transportPair()

    const pending = b.request('never-replies', {})
    b.close()

    await expect(pending).rejects.toThrow('JSON-RPC transport closed')
  })

  it('rejects a request when writing the frame throws', async () => {
    const input = new PassThrough()
    const output = {
      write() {
        throw new Error('write exploded')
      },
    }
    const transport = new JsonRpcLineTransport(input, output as never)

    await expect(transport.request('write-fails', {})).rejects.toThrow('write exploded')
  })

  it.each(leftoverRejects)('stringifies leftover $label write throws', async ({ reason, text }) => {
    const input = new PassThrough()
    const output = {
      write() {
        throw reason
      },
    }
    const transport = new JsonRpcLineTransport(input, output as never)

    const failure = await transport.request('write-fails', {}).then(
      () => { throw new Error('request unexpectedly succeeded') },
      (error: Thrown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: text })
  })

  it('uses a fallback message for malformed JSON-RPC error responses', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    const pending = b.request('remote-error', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {} })}\n`)

    await expect(pending).rejects.toThrow('JSON-RPC error')
    b.close()
  })

  it('ignores responses that do not match a pending request', async () => {
    const { aToB, bToA, b } = transportPair()
    b.start()

    aToB.write('{"jsonrpc":"2.0","id":"unknown","result":{"ignored":true}}\n')

    // The unmatched response settles nothing and leaves the transport usable:
    // the next real request still resolves with its own reply.
    const pending = b.request('echo', {})
    const requestChunk = (await once(bToA, 'data'))[0] as Buffer | string
    const request = JSON.parse(String(requestChunk)) as { id: string }
    aToB.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { matched: true } })}\n`)

    await expect(pending).resolves.toEqual({ matched: true })
    b.close()
  })
})
