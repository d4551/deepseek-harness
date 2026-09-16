import { createServer, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TypertLookupHost, TypertLookupMap } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished } from 'vitest'
import { apply as applyConnection, type ClientTransportHooks } from '../../../client/connection/src/client/index.ts'
import { apply, inject } from '../src/client/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'drain/notification'(): void
    'drain/request'(
      this: Context,
      request: { readonly agent: TypertLookupHost<TypertLookupMap['agent']>; readonly signal: AbortSignal },
      next: () => Promise<string>,
    ): Promise<string>
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends Record<'drain/notification' | 'drain/request', true> {}
}

async function openFixture() {
  const listener = Promise.withResolvers<ServerResponse>()
  const streamClosed = Promise.withResolvers<undefined>()
  const responses = new Set<ServerResponse>()
  const results: string[] = []
  let carrier: ServerResponse | undefined
  const server = createServer((request, response) => {
    responses.add(response)
    response.once('close', () => responses.delete(response))
    if (request.url === '/events') {
      carrier = response
      response.once('close', () => { streamClosed.resolve(undefined) })
      response.write(`${JSON.stringify({ type: 'ready', clientId: 'drain-client', host: { home: '/drain' } })}\n`)
    } else if (request.url === '/listener') {
      listener.resolve(response)
    } else if (request.url === '/barrier') {
      response.end('barrier')
    } else {
      results.push(request.url ?? '')
      response.writeHead(500)
      response.end('Unexpected result after cancellation')
    }
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => { server.once('listening', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Listener test requires TCP')
  const origin = `http://127.0.0.1:${String(address.port)}`
  const transport: ClientTransportHooks = {
    fetch: (url, init) => fetch(new URL(url.pathname, origin), init),
    async *openStream(_endpoint, _payload, signal) {
      const response = await fetch(`${origin}/events`, { signal })
      if (response.body === null) throw new Error('Remote events require a response body')
      const decoder = new TextDecoder()
      let buffered = ''
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true })
        let newline = buffered.indexOf('\n')
        while (newline !== -1) {
          const frame = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          yield JSON.parse(frame)
          newline = buffered.indexOf('\n')
        }
      }
    },
  }
  Object.assign(globalThis, { __DSH_TRANSPORT__: transport })
  const ctx = new Context()
  onTestFinished(async () => {
    for (const response of responses) response.end('released')
    await ctx.fiber.dispose()
    Reflect.deleteProperty(globalThis, '__DSH_TRANSPORT__')
    server.closeAllConnections()
    await server[Symbol.asyncDispose]()
  })
  await ctx.plugin({ apply: applyConnection })
  await ctx.plugin(TypertRegistry)
  const ready = Promise.withResolvers<undefined>()
  ctx.on('connection/reset', () => { ready.resolve(undefined) })
  const gateway = ctx.plugin({ apply, inject })
  await gateway
  await ready.promise
  const target = ctx.extend()
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => candidate === target ? SessionId('drain-agent') : undefined,
    resolve: id => id === 'drain-agent' ? target : undefined,
  })
  return {
    ctx, target, gateway, listener: listener.promise, streamClosed: streamClosed.promise, results,
    listenerUrl: `${origin}/listener`,
    barrier: async () => { await (await fetch(`${origin}/barrier`)).text() },
    send(frame: object) {
      if (carrier === undefined) throw new Error('Remote event carrier did not open')
      carrier.write(`${JSON.stringify(frame)}\n`)
    },
  }
}

it.each(['notification', 'waterfall', 'cancelled waterfall', 'cancelled rejected waterfall'])('drains the actual %s listener before disposal completes', async (kind) => {
  const fixture = await openFixture()
  const entered = Promise.withResolvers<AbortSignal>()
  let completed = false
  if (kind === 'notification') {
    fixture.ctx.remote.$on('drain/notification', async () => {
      await (await fetch(fixture.listenerUrl)).text()
      completed = true
    })
    fixture.send({ type: 'emit', event: 'drain/notification', args: [] })
  } else {
    fixture.target.remote.$on('drain/request', async (request) => {
      entered.resolve(request.signal)
      await (await fetch(fixture.listenerUrl)).text()
      completed = true
      if (kind === 'cancelled rejected waterfall') throw new Error('Listener rejected after cancellation')
      return 'completed'
    })
    fixture.send({ type: 'waterfall', event: 'drain/request', eventId: 'drain-event', agentId: 'drain-agent', request: {} })
  }
  const response = await fixture.listener
  if (kind.startsWith('cancelled')) {
    const signal = await entered.promise
    const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    fixture.send({ type: 'cancel', eventId: 'drain-event' })
    await aborted
  }
  let disposed = false
  const disposal = fixture.gateway.dispose().then(() => { disposed = true })
  await fixture.streamClosed
  await fixture.barrier()
  if (kind !== 'notification') expect((await entered.promise).aborted).toBe(true)
  expect(completed).toBe(false)
  expect(disposed).toBe(false)
  expect(fixture.results).toEqual([])
  response.end('completed')
  await disposal
  expect(completed).toBe(true)
  expect(fixture.results).toEqual([])
})
