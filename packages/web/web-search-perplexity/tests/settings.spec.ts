/** The `web-search-perplexity` settings section layered over the composition entry. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as searchPlugin from '../src/index.ts'
import { WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE } from '../src/index.ts'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

/** Mount the seam, a writable document, and the plugin. */
async function boot(config: searchPlugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  const settings = ctx.plugin(MemorySettings)
  await settings.await()
  await ctx.plugin(WebRuntime, {})
  await ctx.plugin({
    name: 'web-search-perplexity-settings-test',
    inject: ['web'],
    apply: (pluginCtx: Context) => {
      searchPlugin.apply(pluginCtx, searchPlugin.Config(config))
    },
  })
  return ctx
}

/** The descriptor this plugin publishes for its own namespace, redacted as a wire read is. */
function section(ctx: Context) {
  return ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE)
}

describe('web-search-perplexity settings', () => {
  it('publishes its options and declares that a change waits for the next boot', async () => {
    const ctx = await boot({ baseURL: 'https://pplx.entry.test', model: 'sonar-pro', maxTokens: 512 })

    expect(section(ctx)?.base).toMatchObject({ baseURL: 'https://pplx.entry.test', model: 'sonar-pro', maxTokens: 512 })
    expect(section(ctx)?.applies).toBe('restart')
  })

  it('reports a configured key as a secret slot and never rides its value', async () => {
    const ctx = await boot({ apiKey: 'literal-key' })

    expect(section(ctx)?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    expect(section(ctx)?.value).not.toHaveProperty('apiKey')
    expect(JSON.stringify(section(ctx))).not.toContain('literal-key')
  })

  it('resolves a stored key over the composition entry without exposing either', async () => {
    const ctx = await boot({})
    expect(section(ctx)?.secrets).toEqual([{ path: ['apiKey'], set: false }])

    await ctx.settings.update(WEB_SEARCH_PERPLEXITY_SETTINGS_NAMESPACE, { apiKey: 'stored-key' })

    expect(section(ctx)?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    expect(JSON.stringify(section(ctx))).not.toContain('stored-key')
  })
})
