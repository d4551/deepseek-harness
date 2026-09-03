/** The `web` settings section layered over the seam's composition entry. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime, {
  WEB_SETTINGS_NAMESPACE,
  type WebSearchProvider,
  type WebSearchResult,
} from '@deepseek-ai/dsh-web'

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

function searchProvider(id: string): WebSearchProvider {
  const result: WebSearchResult = { content: id, sources: [], truncated: false }
  return { id, available: () => true, search: () => Promise.resolve(result) }
}

/** Mount the seam over a writable settings document with two search backends. */
async function boot(config: ConstructorParameters<typeof WebRuntime>[1] = {}) {
  const ctx = new Context()
  const settings = ctx.plugin(MemorySettings)
  await settings.await()
  await ctx.plugin(WebRuntime, config)
  ctx.web.registerSearchProvider(searchProvider('deepseek-official'))
  ctx.web.registerSearchProvider(searchProvider('exa'))
  return { ctx, settings }
}

describe('web selection settings', () => {
  it('describes the seam selection as a namespace whose composition layer is the entry', async () => {
    const { ctx } = await boot({ searchProvider: 'deepseek-official', fetchProvider: 'playwright' })

    const descriptor = ctx.settings.describe().find(entry => entry.ns === WEB_SETTINGS_NAMESPACE)

    expect(descriptor?.base).toEqual({ searchProvider: 'deepseek-official', fetchProvider: 'playwright' })
    expect(descriptor?.applies).toBe('live')
  })

  it('serves the next search through a provider the stored section names', async () => {
    const { ctx } = await boot({ searchProvider: 'deepseek-official' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'deepseek-official' })

    await ctx.settings.update(WEB_SETTINGS_NAMESPACE, { searchProvider: 'exa' })

    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })
  })

  it('falls back to the composition entry when the settings provider goes away', async () => {
    const { ctx, settings } = await boot({ searchProvider: 'deepseek-official' })
    await ctx.settings.update(WEB_SETTINGS_NAMESPACE, { searchProvider: 'exa' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })

    await settings.dispose()

    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'deepseek-official' })
  })

  it('reads the environment override only while the section names no provider', async () => {
    const ctx = new Context()
    const settings = ctx.plugin(MemorySettings)
    await settings.await()
    process.env.DSH_WEB_SEARCH_PROVIDER = 'exa'
    try {
      await ctx.plugin(WebRuntime, {})
      ctx.web.registerSearchProvider(searchProvider('deepseek-official'))
      ctx.web.registerSearchProvider(searchProvider('exa'))
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'exa' })

      await ctx.settings.update(WEB_SETTINGS_NAMESPACE, { searchProvider: 'deepseek-official' })

      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'deepseek-official' })
    } finally {
      delete process.env.DSH_WEB_SEARCH_PROVIDER
    }
  })
})
