import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import * as Litert from '@deepseek-ai/dsh-llm-litert'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it, onTestFinished } from 'vitest'

async function runtime() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-llm-registration-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  const key = credentialRef(`REGISTRATION_${randomUUID().replaceAll('-', '_')}`)
  await ctx.credentials.set(key, randomUUID())
  const connection = resolveAdapterOptions({ apiKeyEnv: key })
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
  ctx.llm.registerAdapter(['base-route'], adapter)
  return { ctx, adapter }
}

describe('LLM registration lifecycle', () => {
  for (const kind of ['adapter', 'directory', 'discovery']) {
    it(`${kind} withdrawal follows its containing effect's asynchronous cleanup`, async () => {
      const { ctx, adapter } = await runtime()
      const started = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      onTestFinished(() => { release.resolve(undefined) })
      const fiber = await ctx.plugin({
        inject: ['llm'],
        apply(inner: Context) {
          inner.effect(function* () {
            yield kind === 'adapter'
              ? inner.llm.registerAdapter(['owned-route'], adapter)
              : kind === 'directory'
                ? inner.llm.registerConfigurableProviders([{
                  provider: 'owned-route', displayName: 'Owned route', settingsNs: 'owned-settings', settingsPath: [],
                }])
                : inner.llm.registerModelDiscovery('owned-settings', () => ctx.llm.listModels('base-route'))
            yield async () => {
              started.resolve(undefined)
              await release.promise
            }
          }, 'request-owner')
        },
      })

      const disposal = fiber.dispose()
      await started.promise
      const present = kind === 'adapter'
        ? ctx.llm.listProviders().some(provider => provider.id === 'owned-route')
        : kind === 'directory'
          ? ctx.llm.listConfigurableProviders().some(provider => provider.provider === 'owned-route')
          : (await ctx.llm.discoverModels('owned-settings', { provider: 'base-route' })).length > 0
      release.resolve(undefined)
      await disposal
      expect(present).toBe(true)
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['base-route'])
      expect(ctx.llm.listConfigurableProviders()).toEqual([])
      await expect(ctx.llm.discoverModels('owned-settings', { provider: 'base-route' }))
        .rejects.toMatchObject({ code: 'NO_DISCOVERY' })
    })
  }

  it('withdraws routes and directory entries before returning their cleanup settlement', async () => {
    const { ctx, adapter } = await runtime()
    const route = ctx.llm.registerAdapter(['owned-route'], adapter)
    const directory = ctx.llm.registerConfigurableProviders([{
      provider: 'owned-route', displayName: 'Owned route', settingsNs: 'owned-settings', settingsPath: [],
    }])
    const routeCleanup = route()
    const directoryCleanup = directory()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['base-route'])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(() => { route.replace(['returned-route']) }).toThrow('disposed adapter registration')
    expect(() => { directory.replace([]) }).toThrow('was disposed')
    await routeCleanup
    await directoryCleanup
  })

  it('preserves the real LiteRT endpoint hosting posture in detached provider listings', async () => {
    const { ctx } = await runtime()
    await ctx.plugin(LocalSubprocess)
    const fiber = await ctx.plugin(Litert, {
      provider: 'owned-litert',
      displayName: 'Owned LiteRT',
      baseURL: 'http://127.0.0.1:9379/v1',
      models: [{ id: 'gemma', contextWindow: 32768, maxTokens: 4096 }],
    })
    const listed = ctx.llm.listProviders().find(provider => provider.id === 'owned-litert')
    expect(listed).toEqual({ id: 'owned-litert', name: 'Owned LiteRT', hosting: 'self-hosted' })
    if (listed === undefined) throw new Error('The mounted LiteRT provider is missing.')
    listed.hosting = 'local'
    expect(ctx.llm.listProviders().find(provider => provider.id === 'owned-litert')?.hosting).toBe('self-hosted')
    await fiber.dispose()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['base-route'])
  })
})
