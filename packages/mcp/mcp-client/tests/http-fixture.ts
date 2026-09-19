/** Keyless stateless Streamable HTTP MCP fixture for integration tests. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Values a Promise reject arm may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/**
 * Human text for a rejected HTTP fixture request.
 * @param reason - the Thrown the Promise rejected with.
 * @returns the Error string, primitive text, or object tag.
 */
function thrownMessage(reason: Thrown): string {
  if (reason instanceof Error) return String(reason)
  switch (typeof reason) {
    case 'string': return reason
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(reason)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (reason === null) return 'null'
      return Object.prototype.toString.call(reason)
  }
}

/** Running HTTP fixture and the request headers it observed. */
export interface HttpMcpFixture {
  url: string
  authorization: Array<string | undefined>
  close: () => Promise<void>
}

/** Start a local stateless MCP endpoint exposing one `ping` tool. */
export async function startHttpMcpFixture(): Promise<HttpMcpFixture> {
  const authorization: Array<string | undefined> = []
  const closing: Promise<void>[] = []
  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    authorization.push(request.headers.authorization)
    const mcp = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    const transport = new StreamableHTTPServerTransport({})
    response.on('close', () => {
      closing.push(transport.close(), mcp.close())
    })
    await mcp.connect(transport as Transport)
    await transport.handleRequest(request, response)
  }
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error: Thrown) => {
      response.writeHead(500).end(thrownMessage(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP MCP fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    authorization,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      await Promise.all(closing)
    },
  }
}
