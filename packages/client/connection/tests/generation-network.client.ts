import { createServer, type ServerResponse } from 'node:http'
import { onTestFinished } from 'vitest'
import type { ConnectionGenerationSource } from '../src/client/connection.ts'

/** Serve real generation streams with independently releasable cleanup responses. */
export async function serveGenerations(holdFirstReady = false, gatewayFrames = false) {
  const requests = new Map<string, PromiseWithResolvers<ServerResponse>>()
  const responses = new Set<ServerResponse>()
  let closing = false
  let sequence = 0
  const request = (path: string): PromiseWithResolvers<ServerResponse> => {
    let entry = requests.get(path)
    if (entry === undefined) {
      entry = Promise.withResolvers<ServerResponse>()
      requests.set(path, entry)
    }
    return entry
  }
  const server = createServer((incoming, response) => {
    const path = incoming.url
    if (path === undefined) throw new Error('Generation request requires a path')
    request(path).resolve(response)
    responses.add(response)
    response.once('close', () => responses.delete(response))
    response.setHeader('Content-Type', 'text/plain')
    response.flushHeaders()
    if (closing) response.end('closed')
    else if (path.startsWith('/source/') && !(holdFirstReady && path === '/source/1')) {
      response.write(gatewayFrames
        ? JSON.stringify({ type: 'ready', clientId: path, host: { home: path } })
        : path)
    }
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => { server.once('listening', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Generation server requires TCP')
  const origin = `http://127.0.0.1:${String(address.port)}`
  async function *stream(signal: AbortSignal): AsyncGenerator<string> {
    const id = ++sequence
    try {
      const response = await fetch(`${origin}/source/${String(id)}`, { signal })
      if (response.body === null) throw new Error('Generation response requires a body')
      for await (const chunk of response.body) yield new TextDecoder().decode(chunk)
    } finally {
      const response = await fetch(`${origin}/retire/${String(id)}`)
      await response.text()
    }
  }
  const source: ConnectionGenerationSource = async (signal, ready) => {
    for await (const home of stream(signal)) ready({ home })
  }
  const owners: Array<() => Promise<void>> = []
  onTestFinished(async () => {
    closing = true
    for (const response of responses) response.end('closed')
    await Promise.all(owners.map(dispose => dispose()))
    server.closeAllConnections()
    await server[Symbol.asyncDispose]()
  })
  return { source, stream, request: (path: string) => request(path).promise, owners }
}
