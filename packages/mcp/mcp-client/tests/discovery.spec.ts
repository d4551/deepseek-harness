import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { publicToolName, syncTools, type ToolBridgeOptions } from '../src/tools.ts'

const options: ToolBridgeOptions = {
  registrationFailure: 'throw',
  serverName: 'discovery',
  toolCallTimeoutMs: 60_000,
}

describe('MCP discovery identities and pagination', () => {
  let ctx: Context
  let client: Client
  let server: McpServer

  beforeEach(() => {
    ctx = new Context()
    client = new Client({ name: 'discovery-test', version: '1' })
    server = new McpServer({ name: 'discovery-server', version: '1' }, { capabilities: { tools: {} } })
  })

  afterEach(async () => {
    await client.close()
    await server.close()
    await ctx.fiber.dispose()
  })

  it.each([
    ['a__b', 'c', 'a', 'b__c'],
    ['a_', 'b', 'a', '_b'],
  ])('distinguishes the server/tool boundary in %s / %s', (serverA, toolA, serverB, toolB) => {
    expect(publicToolName(serverA, toolA)).not.toBe(publicToolName(serverB, toolB))
  })

  it.each([
    { pages: ['repeated', 'repeated'], requested: [undefined, 'repeated'] },
    { pages: ['a', 'b', 'a'], requested: [undefined, 'a', 'b'] },
    { pages: ['', ''], requested: [undefined, ''] },
  ])('rejects cursor cycle $pages before replacing the registered generation', async ({ pages, requested }) => {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'original', inputSchema: { type: 'object' } }],
    }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const previous = await syncTools(client, ctx, options, new Map())
    const original = ctx.tools.get('mcp__discovery__original')
    const cursors: Array<string | undefined> = []
    server.server.setRequestHandler(ListToolsRequestSchema, (request) => {
      cursors.push(request.params?.cursor)
      return {
        tools: [],
        nextCursor: pages[cursors.length - 1],
      }
    })

    await expect(syncTools(client, ctx, options, previous)).rejects.toThrow('pagination cursor repeated')
    expect(cursors).toEqual(requested)
    expect(ctx.tools.get('mcp__discovery__original')).toBe(original)
    expect([...previous.keys()]).toEqual(['mcp__discovery__original'])
  })

  it('follows an empty opaque cursor and publishes the complete tool list', async () => {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const cursors: Array<string | undefined> = []
    server.server.setRequestHandler(ListToolsRequestSchema, (request) => {
      cursors.push(request.params?.cursor)
      return request.params?.cursor === undefined
        ? { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: '' }
        : { tools: [{ name: 'second', inputSchema: { type: 'object' } }] }
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const registered = await syncTools(client, ctx, options, new Map())

    expect(cursors).toEqual([undefined, ''])
    expect([...registered.keys()]).toEqual(['mcp__discovery__first', 'mcp__discovery__second'])
    expect(ctx.tools.get('mcp__discovery__first')).toBeDefined()
    expect(ctx.tools.get('mcp__discovery__second')).toBeDefined()
  })
})
