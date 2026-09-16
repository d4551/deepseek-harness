import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { createServer } from 'vite'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, expect, it } from 'vitest'
import {
  parseRemoteStreamClientMessage,
  REMOTE_STREAM_MUX_PATH,
  type RemoteStreamClientMessage,
} from '../src/stream-protocol.ts'
import type {} from './stream-client-page.client.ts'

interface NetworkFixture {
  readonly page: Page
  readonly sockets: WebSocketServer
  readonly pending: Set<Duplex>
  readonly upgraded: PromiseWithResolvers<Duplex>
  readonly errors: string[]
  mode: 'accept' | 'reject' | 'hold'
  attempts: number
}

const cleanups: AsyncDisposableStack[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup.disposeAsync()
})

async function openFixture(): Promise<NetworkFixture> {
  const cleanup = new AsyncDisposableStack()
  cleanups.push(cleanup)
  const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-stream-client-vite-'))
  cleanup.defer(() => rm(cacheDir, { recursive: true }))
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
    cacheDir,
    resolve: { tsconfigPaths: true },
    optimizeDeps: { entries: [fileURLToPath(new URL('./stream-client-page.client.ts', import.meta.url))] },
    server: { host: '127.0.0.1', port: 0 },
    appType: 'custom',
  })
  cleanup.defer(() => server.close())
  server.middlewares.use((request, response, next) => {
    if (request.url !== '/') {
      next()
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end('<!doctype html><title>Remote stream lifecycle</title>'
      + '<script type="module" src="/packages/api/gateway/tests/stream-client-page.client.ts"></script>')
  })
  const http = server.httpServer
  if (http === null) throw new Error('The stream lifecycle server requires HTTP')
  const sockets = new WebSocketServer({ noServer: true })
  const pending = new Set<Duplex>()
  cleanup.defer(async () => {
    for (const socket of pending) socket.destroy()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      sockets.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })
  await server.listen()
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('The stream lifecycle server requires TCP')
  const browser = await chromium.launch()
  cleanup.defer(() => browser.close())
  const page = await browser.newPage()
  const fixture: NetworkFixture = {
    page, sockets, pending,
    upgraded: Promise.withResolvers<Duplex>(),
    errors: [],
    mode: 'accept',
    attempts: 0,
  }
  cleanup.defer(async () => {
    await page.evaluate(() => window.streamClient?.close())
    expect(fixture.errors).toEqual([])
  })
  page.on('pageerror', error => fixture.errors.push(error.message))
  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== REMOTE_STREAM_MUX_PATH) return
    fixture.attempts += 1
    if (fixture.mode === 'reject') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } else if (fixture.mode === 'hold') {
      fixture.pending.add(socket)
      socket.once('close', () => fixture.pending.delete(socket))
      socket.once('end', () => { socket.end() })
      socket.resume()
      fixture.upgraded.resolve(socket)
    } else {
      sockets.handleUpgrade(request, socket, head, connected => sockets.emit('connection', connected, request))
    }
  })
  await page.goto(`http://127.0.0.1:${String(address.port)}`)
  await page.waitForFunction(() => window.streamClient !== undefined)
  return fixture
}

function connection(sockets: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => { sockets.once('connection', resolve) })
}

function frame(socket: WebSocket): Promise<RemoteStreamClientMessage> {
  return new Promise((resolve) => {
    socket.once('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new Error('The browser must send a text frame')
      resolve(parseRemoteStreamClientMessage(data.toString('utf8')))
    })
  })
}

it('shares a native socket, reconnects after carrier loss, and disposes active streams', async () => {
  const fixture = await openFixture()
  const connected = connection(fixture.sockets)
  await fixture.page.evaluate(() => {
    window.streamClient.start()
    window.streamClient.start()
  })
  const socket = await connected
  const opened = frame(socket)
  const item = fixture.page.evaluate(async () => {
    for await (const value of window.streamClient.open('feed/follow', { topic: 'first' }, window.streamCancellation.signal)) {
      return value
    }
  })
  const request = await opened
  expect(request).toMatchObject({ type: 'open', endpoint: 'feed/follow', payload: { topic: 'first' } })
  const cancelled = frame(socket)
  socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: 'delivered' }))
  expect(await item).toBe('delivered')
  expect(await cancelled).toEqual({ type: 'cancel', streamId: request.streamId })
  expect(fixture.attempts).toBe(1)

  const retry = fixture.page.waitForEvent('console', message => message.type() === 'warning')
  const replacement = connection(fixture.sockets)
  socket.terminate()
  expect((await retry).text()).toContain('retry #1')
  const next = await replacement
  expect(fixture.attempts).toBe(2)
  const active = frame(next)
  const rejected = expect(fixture.page.evaluate(() => window.streamClient.open(
    'feed/follow', {}, window.streamCancellation.signal,
  ).next())).rejects.toThrow('Remote stream client disposed')
  await active
  const closed = once(next, 'close')
  await fixture.page.evaluate(() => window.streamClient.close())
  await rejected
  await closed
  await fixture.page.evaluate(() => { window.streamClient.start() })
  await expect(fixture.page.evaluate(() => window.streamClient.open(
    'feed/follow', {}, window.streamCancellation.signal,
  ).next())).rejects.toThrow('Remote stream client disposed')
  expect(fixture.sockets.clients.size).toBe(0)
})

it('retains a logical waiter across a refused handshake and retries the real connection', async () => {
  const fixture = await openFixture()
  fixture.mode = 'reject'
  const retry = fixture.page.waitForEvent('console', message => message.type() === 'warning')
  const result = fixture.page.evaluate(() => window.streamClient.open(
    'feed/follow', {}, window.streamCancellation.signal,
  ).next())
  expect((await retry).text()).toContain('retry #1')
  const connected = connection(fixture.sockets)
  fixture.mode = 'accept'
  const socket = await connected
  const request = await frame(socket)
  socket.send(JSON.stringify({ type: 'end', streamId: request.streamId }))
  expect(await result).toEqual({ done: true, value: undefined })
  expect(fixture.attempts).toBe(2)
})

it('settles disposal during reconnect backoff', async () => {
  const fixture = await openFixture()
  fixture.mode = 'reject'
  const retry = fixture.page.waitForEvent('console', message => message.type() === 'warning')
  await fixture.page.evaluate(() => { window.streamClient.start() })
  expect((await retry).text()).toContain('retry #1')
  await fixture.page.evaluate(() => window.streamClient.close())
  await expect(fixture.page.evaluate(() => window.streamClient.open(
    'feed/follow', {}, window.streamCancellation.signal,
  ).next())).rejects.toThrow('Remote stream client disposed')
  expect(fixture.attempts).toBe(1)
})

it('cancels an outstanding native handshake and rejects its logical waiter', async () => {
  const fixture = await openFixture()
  fixture.mode = 'hold'
  const rejected = expect(fixture.page.evaluate(() => window.streamClient.open(
    'feed/follow', {}, window.streamCancellation.signal,
  ).next())).rejects.toThrow('Remote stream client disposed')
  const socket = await fixture.upgraded.promise
  const closed = once(socket, 'close')
  await fixture.page.evaluate(() => window.streamClient.close())
  await rejected
  await closed
  expect(fixture.pending.size).toBe(0)
  expect(fixture.attempts).toBe(1)
})
