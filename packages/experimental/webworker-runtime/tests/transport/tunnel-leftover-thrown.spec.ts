import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TunnelOutboundFrame } from '../../src/transport/frames.ts'
import { describeFailure, TunnelServer, type TunnelSeams } from '../../src/transport/tunnel.ts'

function harness(
  requestListener: () => Promise<(req: unknown, res: unknown) => void> = () => Promise.reject(new Error('fixture has no HTTP listener')),
): { server: TunnelServer; frames: TunnelOutboundFrame[] } {
  const frames: TunnelOutboundFrame[] = []
  const server = new TunnelServer({
    port: { postMessage: (frame) => { frames.push(frame) } },
    requestListener,
  })
  return { server, frames }
}

function seams(
  openStream: TunnelSeams['openStream'] = async () => (async function *(): AsyncGenerator { yield undefined })(),
): TunnelSeams {
  return {
    directFetch: () => Promise.reject(new Error('fixture has no direct fetch')),
    bootPayload: () => ({ boot: true }),
    openStream,
    streamFailure: error => ({
      code: 'fixture-stream-failed',
      message: error instanceof Error ? error.message : String(error),
      details: { fixture: true },
    }),
  }
}

function responseBody(frame: TunnelOutboundFrame | undefined): string {
  if (frame?.t !== 'res' || frame.body === undefined) throw new Error('expected a unary refusal body')
  return new TextDecoder().decode(frame.body)
}

describe('describeFailure claim-boundary renderer', () => {
  it('renders nested Thrown boot failures without changing the unknown helper', () => {
    const inner = new Error('plugin exploded')
    const wrapped = new Error('loader entries failed to apply', { cause: inner })
    const aggregate = new AggregateError([wrapped, 'row-string'], 'boot')
    expect(describeFailure(aggregate)).toBe([
      'AggregateError: boot',
      '  Error: loader entries failed to apply',
      '    Error: plugin exploded',
      '  row-string',
    ].join('\n'))
    expect(describeFailure('plain string')).toBe('plain string')
    expect(describeFailure(7)).toBe('7')
    expect(describeFailure(true)).toBe('true')
    expect(describeFailure({ reason: 'object' })).toBe('{"reason":"object"}')
    expect(describeFailure(undefined)).toBe('')
    expect(describeFailure(null)).toBe('')
    expect(describeFailure(Symbol.for('boot'))).toBe('symbol')
    expect(describeFailure(() => undefined)).toBe('function')
    const cyclic = new Error('outer')
    cyclic.cause = cyclic
    expect(describeFailure(cyclic)).toBe('Error: outer')
    const deep = new Error('d0', {
      cause: new Error('d1', {
        cause: new Error('d2', {
          cause: new Error('d3', {
            cause: new Error('d4', {
              cause: new Error('d5', {
                cause: new Error('d6', { cause: new Error('d7') }),
              }),
            }),
          }),
        }),
      }),
    })
    expect(describeFailure(deep).split('\n')).toHaveLength(7)
  })
})

describe('TunnelServer.fail leftover Thrown claim', () => {
  it.each([
    [new Error('image failed'), 'Error: image failed'],
    ['boot string', 'boot string'],
    [12, '12'],
    [{ stage: 'image' }, '{"stage":"image"}'],
    [undefined, ''],
  ] as const)('passes leftover Thrown %s into describeFailure', (reason, message) => {
    const { server, frames } = harness()
    server.handleMessage({ t: 'req', id: 1, method: 'GET', url: 'http://localhost/queued', headers: {} })
    server.handleMessage({ t: 'stream-open', id: 2, endpoint: '$events', payload: {} })
    server.fail(reason)
    server.handleMessage({ t: 'req', id: 3, method: 'GET', url: 'http://localhost/later', headers: {} })
    expect(frames).toEqual([
      expect.objectContaining({ t: 'res', id: 1, status: 503, message }),
      { t: 'stream-error', id: 2, failure: { kind: 'carrier', message } },
      expect.objectContaining({ t: 'res', id: 3, status: 503, message }),
    ])
    expect(responseBody(frames[0])).toBe(message)
    expect(responseBody(frames[2])).toBe(message)
  })
})

describe('tunnel leftover Promise reject Thrown claim', () => {
  it.each([
    [new Error('listener exploded'), 'listener exploded'],
    ['listener string', 'listener string'],
    [9, '9'],
    [false, 'false'],
    [10n, '10'],
    [Symbol.for('listener'), 'Symbol(listener)'],
    [undefined, 'undefined'],
    [null, 'null'],
    [{}, '[object Object]'],
    [() => undefined, String(() => undefined)],
  ])('renders a leftover listener reject as Thrown %s', async (reason, message) => {
    const { server, frames } = harness(async () => { throw reason })
    server.serve(seams())
    server.handleMessage({ t: 'req', id: 10, method: 'GET', url: 'http://localhost/static.txt', headers: {} })
    await vi.waitFor(() => {
      expect(frames).toEqual([{ t: 'res-err', id: 10, message }])
    })
  })

  it('contains a leftover response-delivery reject without restoring unknown catch arms', async () => {
    const frames: TunnelOutboundFrame[] = []
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args) }
    onTestFinished(() => { console.error = original })
    const server = new TunnelServer({
      port: {
        postMessage(frame) {
          if (frame.t === 'stream-error') throw 'delivery string'
          frames.push(frame)
        },
      },
      requestListener: async () => { throw 'listener unused' },
    })
    server.serve(seams(async () => { throw new Error('Host stream exploded') }))
    server.handleMessage({ t: 'stream-open', id: 11, endpoint: 'probe/watch', payload: {} })
    await vi.waitFor(() => {
      expect(errors).toEqual([['webworker tunnel: response delivery failed', 'delivery string']])
    })
    expect(frames).toEqual([])
  })
})

describe('tunnel leftover Thrown callers', () => {
  it('refuses a leftover duplicate init and drops queued work that was aborted before serve', async () => {
    const { server, frames } = harness()
    expect(() => {
      server.handleMessage({ t: 'init', image: 'image://base', overlays: [] })
    }).toThrow('webworker tunnel: duplicate init frame; the tunnel is already open')
    server.handleMessage({ t: 'req', id: 21, method: 'GET', url: 'http://localhost/queued', headers: {} })
    server.handleMessage({ t: 'abort', id: 21 })
    server.handleMessage({ t: 'abort', id: 99 })
    server.serve(seams())
    expect(frames).toEqual([])
  })

  it('claims leftover direct-lane throws through the request catch as Thrown', async () => {
    const frames: TunnelOutboundFrame[] = []
    const server = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: async () => { throw 'listener unused' },
      unaryApiLane: 'direct',
      privilegedMethods: new Set(['session/list']),
    })
    server.serve({
      ...seams(),
      directFetch: async () => { throw 'direct string' },
    })
    server.handleMessage({
      t: 'req', id: 22, method: 'POST', url: 'http://localhost/api/session/list', headers: { cookie: 'x' },
    })
    await vi.waitFor(() => {
      expect(frames).toEqual([{ t: 'res-err', id: 22, message: 'direct string' }])
    })
  })

  it('answers leftover boot, streamed route, and empty direct bodies', async () => {
    const frames: TunnelOutboundFrame[] = []
    const server = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: () => Promise.resolve((_req, response) => {
        const res = response as {
          writeHead(status: number, headers?: Record<string, string>): unknown
          write(chunk: string): boolean
          end(body?: string): unknown
          destroy(): unknown
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('ab')
        res.end('cd')
      }),
      privilegedMethods: new Set(['empty']),
    })
    server.serve({
      ...seams(),
      directFetch: async (request) => {
        if (request.method === 'HEAD') return new Response(null, { status: 204 })
        return new Response(null, { status: 204 })
      },
    })
    server.handleMessage({ t: 'req', id: 23, method: 'GET', url: 'http://localhost/__boot__', headers: {} })
    server.handleMessage({ t: 'req', id: 24, method: 'POST', url: 'http://localhost/__boot__', headers: {} })
    server.handleMessage({ t: 'req', id: 25, method: 'GET', url: 'http://localhost/streamed', headers: {} })
    server.handleMessage({
      t: 'req', id: 26, method: 'HEAD', url: 'http://localhost/api/empty', headers: {}, body: new ArrayBuffer(1),
    })
    await vi.waitFor(() => {
      expect(frames.some(frame => frame.t === 'res' && frame.id === 23 && frame.status === 200)).toBe(true)
      expect(frames.some(frame => frame.t === 'res' && frame.id === 24 && frame.status === 405)).toBe(true)
      expect(frames.some(frame => frame.t === 'res-head' && frame.id === 25)).toBe(true)
      expect(frames.some(frame => frame.t === 'res-chunk' && frame.id === 25)).toBe(true)
      expect(frames.some(frame => frame.t === 'res-end' && frame.id === 25)).toBe(true)
      expect(frames.some(frame => frame.t === 'res' && frame.id === 26 && frame.status === 204)).toBe(true)
    })
  })

  it('aborts a leftover in-flight route before the listener writes', async () => {
    const frames: TunnelOutboundFrame[] = []
    const opened = Promise.withResolvers<undefined>()
    const server = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: () => Promise.resolve((_req, response) => {
        opened.resolve(undefined)
        const res = response as { writeHead(status: number): unknown; end(body?: string): unknown }
        res.writeHead(200)
        res.end('late')
      }),
    })
    let resolveListener: ((listener: (req: unknown, res: unknown) => void) => void) | undefined
    const pendingListener = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: () => new Promise((resolve) => { resolveListener = resolve }),
    })
    pendingListener.serve(seams())
    pendingListener.handleMessage({ t: 'req', id: 27, method: 'GET', url: 'http://localhost/slow', headers: {} })
    pendingListener.handleMessage({ t: 'abort', id: 27 })
    resolveListener?.((_req, _res) => { throw new Error('aborted listener must not run') })
    server.serve(seams())
    server.handleMessage({ t: 'req', id: 28, method: 'POST', url: 'http://localhost/api/session/list', headers: {} })
    await opened.promise
    server.handleMessage({ t: 'abort', id: 28 })
    await vi.waitFor(() => {
      expect(frames.some(frame => frame.id === 27)).toBe(false)
    })
  })

  it('retries a leftover streamed 401 and reuses the captured listener', async () => {
    const frames: TunnelOutboundFrame[] = []
    let calls = 0
    const server = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: () => Promise.resolve((_req, response) => {
        calls += 1
        const res = response as {
          writeHead(status: number, headers?: Record<string, string>): unknown
          write(chunk: string): boolean
          end(body?: string): unknown
        }
        if (calls === 1) {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.write('refused')
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('ok')
        queueMicrotask(() => { res.end('late') })
      }),
    })
    server.serve({
      ...seams(),
      directFetch: async () => new Response('direct', { status: 200, headers: { 'content-type': 'text/plain' } }),
    })
    server.handleMessage({
      t: 'req', id: 31, method: 'POST', url: 'http://localhost/api/session/list', headers: {},
    })
    await vi.waitFor(() => {
      expect(frames.some(frame => frame.t === 'res' && frame.id === 31 && frame.status === 200)).toBe(true)
    })
    server.handleMessage({ t: 'req', id: 32, method: 'GET', url: 'http://localhost/second', headers: {} })
    await vi.waitFor(() => {
      expect(frames.some(frame => frame.t === 'res-head' && frame.id === 32)).toBe(true)
      expect(frames.some(frame => frame.t === 'res-end' && frame.id === 32)).toBe(true)
    })
  })

  it('claims leftover Error direct throws and destroys through the request catch', async () => {
    const frames: TunnelOutboundFrame[] = []
    const server = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: () => Promise.resolve((_req, response) => {
        const res = response as { destroy(): unknown }
        res.destroy()
      }),
      unaryApiLane: 'direct',
    })
    const routed = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: () => Promise.resolve((_req, response) => {
        const res = response as { destroy(): unknown }
        res.destroy()
      }),
    })
    server.serve({
      ...seams(),
      directFetch: async () => { throw new Error('direct failed') },
    })
    routed.serve(seams())
    server.handleMessage({
      t: 'req', id: 33, method: 'POST', url: 'http://localhost/api/session/list', headers: {}, body: new ArrayBuffer(2),
    })
    routed.handleMessage({ t: 'req', id: 34, method: 'POST', url: 'http://localhost/api/session/list', headers: {} })
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ t: 'res-err', id: 33, message: 'direct failed' })
      expect(frames.some(frame => frame.t === 'res-err' && frame.id === 34)).toBe(true)
    })
  })

  it('streams leftover SSE bodies and stops after abort', async () => {
    const frames: TunnelOutboundFrame[] = []
    const stopped = Promise.withResolvers<undefined>()
    const server = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: async () => { throw 'listener unused' },
      unaryApiLane: 'direct',
    })
    server.serve({
      ...seams(),
      directFetch: async request => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: one\n\n'))
          request.signal.addEventListener('abort', () => {
            controller.close()
            stopped.resolve(undefined)
          }, { once: true })
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    server.handleMessage({ t: 'req', id: 35, method: 'GET', url: 'http://localhost/api/events', headers: {} })
    await vi.waitFor(() => {
      expect(frames.some(frame => frame.t === 'res-head' && frame.id === 35)).toBe(true)
      expect(frames.some(frame => frame.t === 'res-chunk' && frame.id === 35)).toBe(true)
    })
    server.handleMessage({ t: 'abort', id: 35 })
    await stopped.promise
  })

  it('contains leftover stream iteration after abort without publishing a late item or error', async () => {
    const { server, frames } = harness()
    const opened = Promise.withResolvers<AbortSignal>()
    server.serve(seams(async (_endpoint, _payload, signal) => {
      opened.resolve(signal)
      return (async function *(): AsyncGenerator {
        yield 'ready'
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        yield 'late'
        throw 'late stream'
      })()
    }))
    server.handleMessage({ t: 'stream-open', id: 36, endpoint: '$events', payload: {} })
    await opened.promise
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ t: 'stream-item', id: 36, value: 'ready' })
    })
    server.handleMessage({ t: 'abort', id: 36 })
    await vi.waitFor(() => {
      expect(frames).toEqual([{ t: 'stream-item', id: 36, value: 'ready' }])
    })
  })

  it('aborts a leftover buffered /api wait and flushes later streamed writes', async () => {
    const frames: TunnelOutboundFrame[] = []
    const hanging = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: () => Promise.resolve(() => {}),
    })
    hanging.serve(seams())
    hanging.handleMessage({
      t: 'req', id: 40, method: 'POST', url: 'http://localhost/api/session/list', headers: {},
    })
    hanging.handleMessage({ t: 'abort', id: 40 })
    expect(frames.filter(frame => frame.id === 40)).toEqual([])

    const streamed = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: () => Promise.resolve((_req, response) => {
        const res = response as {
          writeHead(status: number, headers?: Record<string, string>): unknown
          write(chunk: string): boolean
          end(body?: string): unknown
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write('a')
        queueMicrotask(() => {
          res.write('b')
          res.end()
        })
      }),
    })
    streamed.serve(seams())
    streamed.handleMessage({
      t: 'req', id: 41, method: 'POST', url: 'http://localhost/api/session/list', headers: {},
    })
    await vi.waitFor(() => {
      expect(frames.some(frame => frame.t === 'res-head' && frame.id === 41)).toBe(true)
      expect(frames.some(frame => frame.t === 'res-end' && frame.id === 41)).toBe(true)
    })
  })

  it('claims leftover SSE read failures as Thrown', async () => {
    const frames: TunnelOutboundFrame[] = []
    const server = new TunnelServer({
      port: { postMessage: (frame) => { frames.push(frame) } },
      requestListener: async () => { throw 'listener unused' },
      unaryApiLane: 'direct',
    })
    server.serve({
      ...seams(),
      directFetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.error('sse string')
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    server.handleMessage({ t: 'req', id: 42, method: 'GET', url: 'http://localhost/api/events', headers: {} })
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ t: 'res-err', id: 42, message: 'sse string' })
    })
  })
})
