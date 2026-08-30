/**
 * Shipped MCP bridge against the official SDK Client + McpServer linked
 * by InMemoryTransport. A local mock client cannot substitute for this path.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { syncTools, type ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

const testToolSignal = new AbortController().signal

const defaultOpts: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
}

describe('official SDK in-memory bridge', () => {
  let ctx: Context
  let client: Client | undefined
  let server: McpServer | undefined

  afterEach(async () => {
    if (client !== undefined) {
      await client.close()
      client = undefined
    }
    if (server !== undefined) {
      await server.close()
      server = undefined
    }
    if (ctx !== undefined) await ctx.fiber.dispose()
  })

  it('lists and calls a tool through Client + McpServer + InMemoryTransport', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    server = new McpServer(
      { name: 'mem', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.registerTool('shout', {
      description: 'Upper-cases a message.',
      inputSchema: { message: z.string() },
    }, async args => ({
      content: [{ type: 'text', text: args.message.toUpperCase() }],
    }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: 'bridge-test', version: '1' })
    await client.connect(clientTransport)

    const disposers = await syncTools(client, ctx, defaultOpts, new Map())
    expect(disposers.has('mcp__srv__shout')).toBe(true)
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('in-memory-shout'),
      name: 'mcp__srv__shout',
      arguments: { message: 'hi' },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'HI' }])
  })
})
