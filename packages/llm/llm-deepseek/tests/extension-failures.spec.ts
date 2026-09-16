import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { DeepSeekLlmApiExtensionRequest } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, onTestFinished } from 'vitest'

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions/types' {
  interface DeepSeekLlmApiExtensionMap {
    dsh_extension_failure_contract: { version: number }
  }
}

async function extensionRequest() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-extension-failure-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  const requests: { method: string | undefined; url: string | undefined; authorization: string | undefined }[] = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"accepted output"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  onTestFinished(() => server[Symbol.asyncDispose]())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The HTTP server has no TCP address.')

  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  const key = credentialRef(`EXTENSION_FAILURE_${randomUUID().replaceAll('-', '_')}`)
  const credential = randomUUID()
  await ctx.credentials.set(key, credential)
  const connection = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${address.port}`, apiKeyEnv: key })
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: async (connection) => {
      const stored = await ctx.credentials.resolve(connection.apiKeyEnv)
      if (stored === undefined) throw new Error('The stored request credential is missing.')
      return stored.value
    },
    resolveUserId: () => getOrCreateAnonymousUserId({ env: { DSH_HOME: home } }),
    prepareExtensions: request => ctx.deepseekLlmApiExtensions.prepare(request),
  })
  return { ctx, adapter, requests, credential }
}

const failures = [
  { label: 'string rejection', reason: 'extension metadata unavailable', detail: 'extension metadata unavailable' },
  { label: 'empty string rejection', reason: '', detail: 'no detail' },
  { label: 'empty Error', reason: new Error(''), detail: 'no detail' },
  { label: 'Error with detail', reason: new Error('extension commit unavailable'), detail: 'extension commit unavailable' },
]

describe('DeepSeek extension failure diagnostics', () => {
  for (const phase of ['preparation', 'acceptance']) {
    it.each(failures)(`${phase} preserves $label without exposing the credential`, async ({ reason, detail }) => {
      const { ctx, adapter, requests, credential } = await extensionRequest()
      const preparedRequests: DeepSeekLlmApiExtensionRequest[] = []
      let accepted = 0
      ctx.deepseekLlmApiExtensions.register('dsh_extension_failure_contract', {
        prepare(request) {
          preparedRequests.push(request)
          if (phase === 'preparation') throw reason
          return {
            value: { version: 1 },
            accept() {
              accepted += 1
              throw reason
            },
          }
        },
      })

      const chunks: StreamChunk[] = []
      const result = (async () => {
        for await (const chunk of adapter.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] })) {
          chunks.push(chunk)
        }
      })()
      await expect(result).rejects.toMatchObject({
        code: 'REQUEST_EXTENSION',
        message: `DeepSeek request extension ${phase} failed: ${detail}`,
        cause: reason,
      })
      await expect(result).rejects.not.toThrow(credential)
      expect(chunks).toEqual([])
      expect(preparedRequests).toHaveLength(1)
      expect(preparedRequests[0]?.body).toMatchObject({ model: 'deepseek-v4-flash', messages: [] })
      expect(JSON.stringify(preparedRequests)).not.toContain(credential)
      expect(accepted).toBe(phase === 'acceptance' ? 1 : 0)
      expect(requests).toEqual(phase === 'acceptance'
        ? [{ method: 'POST', url: '/chat/completions', authorization: `Bearer ${credential}` }]
        : [])
    })
  }
})
