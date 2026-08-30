/** Temporary repro: the e2e declare-route sequence through the real settings service. */
import { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import { Config, assertServiceable } from '../src/config.ts'

const NS = settingsNamespace('llm-pi-ai')

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings)
  ctx.settings.register(NS, Config, { validate: assertServiceable })
  return ctx
}

describe('repro: e2e declare sequence', () => {
  it('accepts the custom provider after earlier profile writes', async () => {
    const ctx = await boot()
    // Earlier e2e steps: blank-key minimax-cn profile, then key ref, then baseURL patch.
    await ctx.settings.mutate(NS, [
      { op: 'set', path: ['providers', 'minimax-cn'], value: {} },
    ])
    await ctx.settings.mutate(NS, [
      { op: 'set', path: ['providers', 'minimax-cn', 'apiKeyEnv'], value: 'MINIMAX_CN_API_KEY' },
    ])
    await ctx.settings.mutate(NS, [
      { op: 'set', path: ['providers', 'minimax-cn', 'baseURL'], value: 'https://gateway.minimax.example/v1' },
    ])
    // The declare step, exactly as CustomProviderCard sends it.
    await ctx.settings.mutate(NS, [
      {
        op: 'set',
        path: ['providers', 'acme-gateway'],
        value: {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: 'https://gateway.acme.example/v1',
          models: [{ id: 'acme-large' }],
        },
      },
    ])
    const section = ctx.settings.describe().find(d => String(d.ns) === 'llm-pi-ai')
    expect(section?.user).toMatchObject({ providers: { 'acme-gateway': { models: [{ id: 'acme-large' }] } } })
  })
})
