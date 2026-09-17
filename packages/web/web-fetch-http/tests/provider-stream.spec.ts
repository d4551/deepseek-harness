import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { HttpFetchProvider, type HttpFetchLimits } from '../src/provider.ts'

const limits: HttpFetchLimits = {
  maxResponseBytes: 1024,
  maxBodyChars: 1024,
  timeoutMs: 5000,
  maxRedirects: 5,
  userAgent: 'native-stream-test',
}

async function serve(handler: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => { handler(response) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP server has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
      })
    },
  }
}

function provider(overrides: Partial<HttpFetchLimits> = {}) {
  return new HttpFetchProvider({ ...limits, ...overrides }, () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]))
}

describe('native HTTP response stream ownership', () => {
  it.each([204, 205, 304])('returns an empty text body for status %i', async (status) => {
    await using server = await serve((response) => {
      response.writeHead(status, { 'content-type': 'text/plain' })
      response.end()
    })
    await expect(provider().fetch({ url: server.url })).resolves.toMatchObject({
      statusCode: status, body: { kind: 'text', content: '' }, truncated: false,
    })
  })

  it('reports a peer disconnect after receiving body bytes without returning partial content', async () => {
    const received = Promise.withResolvers<undefined>()
    const opened = Promise.withResolvers<ServerResponse>()
    const observedChunk = () => { received.resolve(undefined) }
    const chunks = channel('undici:request:bodyChunkReceived')
    chunks.subscribe(observedChunk)
    await using server = await serve((response) => {
      opened.resolve(response)
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      response.write('partial')
    })
    try {
      const pending = provider().fetch({ url: server.url })
      const rejected = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
      await received.promise
      await setImmediate()
      const response = await opened.promise
      const closed = once(response, 'close')
      response.destroy()
      await rejected
      await closed
    } finally {
      chunks.unsubscribe(observedChunk)
    }
  })

  it('preserves caller cancellation during a body read and closes the native response', async () => {
    const received = Promise.withResolvers<undefined>()
    const opened = Promise.withResolvers<ServerResponse>()
    const observedChunk = () => { received.resolve(undefined) }
    const chunks = channel('undici:request:bodyChunkReceived')
    chunks.subscribe(observedChunk)
    await using server = await serve((response) => {
      opened.resolve(response)
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' })
      response.write('partial')
    })
    try {
      const controller = new AbortController()
      const pending = provider().fetch({ url: server.url }, controller.signal)
      const rejected = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
      await received.promise
      await setImmediate()
      const closed = once(await opened.promise, 'close')
      controller.abort(new Error('caller stopped body read'))
      await rejected
      await closed
    } finally {
      chunks.unsubscribe(observedChunk)
    }
  })

  it('cancels a still-open response when the byte cap is reached', async () => {
    const closed = Promise.withResolvers<undefined>()
    await using server = await serve((response) => {
      response.once('close', () => { closed.resolve(undefined) })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('abcdef')
    })
    await expect(provider({ maxResponseBytes: 4 }).fetch({ url: server.url })).resolves.toMatchObject({
      body: { kind: 'text', content: 'abcd' }, truncated: true,
    })
    await closed.promise
  })

  it.each([
    { status: 302, headers: { location: 'https://elsewhere.test/' }, code: 'WEB_REDIRECT_BLOCKED' },
    { status: 302, headers: {}, code: 'WEB_PROVIDER_ERROR' },
    { status: 200, headers: { 'content-type': 'text/plain; charset=not-a-charset' }, code: 'WEB_UNSUPPORTED_CONTENT_TYPE' },
    { status: 200, headers: { 'content-type': 'image/png' }, code: 'WEB_UNSUPPORTED_CONTENT_TYPE' },
    { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '9999' }, code: 'WEB_FETCH_TOO_LARGE' },
  ])('closes a live rejected response: $code, $headers', async ({ status, headers, code }) => {
    const closed = Promise.withResolvers<undefined>()
    await using server = await serve((response) => {
      response.once('close', () => { closed.resolve(undefined) })
      response.writeHead(status, headers)
      response.write('unconsumed body')
    })
    await expect(provider().fetch({ url: server.url }))
      .rejects.toThrow(expect.objectContaining({ code }))
    await closed.promise
  })

  it('cancels an invalid redirect body before the fetch deadline', async () => {
    const closed = Promise.withResolvers<undefined>()
    await using server = await serve((response) => {
      response.once('close', () => { closed.resolve(undefined) })
      response.writeHead(302, { location: 'http://[', 'content-type': 'text/plain' })
      response.write('redirect response remains open')
    })
    await expect(provider({ timeoutMs: 20_000 }).fetch({ url: server.url }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'invalid redirect Location "http://["' }))
    await closed.promise
  }, 3000)
})
