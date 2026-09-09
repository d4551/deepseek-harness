/** The `web-search-exa` settings section layered over the composition entry. */

import { once } from 'node:events'
import { createServer } from 'node:http'
import { text as readText } from 'node:stream/consumers'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as searchPlugin from '../src/index.ts'
import { WEB_SEARCH_EXA_SETTINGS_NAMESPACE } from '../src/index.ts'

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
    name: 'web-search-exa-settings-test',
    inject: ['web'],
    apply: (pluginCtx: Context) => {
      searchPlugin.apply(pluginCtx, searchPlugin.Config(config))
    },
  })
  return ctx
}

/** The descriptor this plugin publishes for its own namespace, redacted as a wire read is. */
function section(ctx: Context) {
  return ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === WEB_SEARCH_EXA_SETTINGS_NAMESPACE)
}

describe('web-search-exa settings', () => {
  it('publishes its options as live settings', async () => {
    const ctx = await boot({ baseURL: 'https://exa.entry.test', searchType: 'keyword', highlightsPerResult: 2 })

    expect(section(ctx)?.base).toMatchObject({ baseURL: 'https://exa.entry.test', searchType: 'keyword', highlightsPerResult: 2 })
    expect(section(ctx)?.applies).toBe('live')
  })

  it('uses committed credentials, endpoint and retrieval settings on the next request', async () => {
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = []
    const bodies: Promise<string>[] = []
    await using server = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization })
      bodies.push(readText(request))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ results: [] }))
    })
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('HTTP listener has no TCP address')
    const origin = `http://127.0.0.1:${address.port}`
    const ctx = await boot({ apiKey: 'entry-key', baseURL: `${origin}/entry` })
    onTestFinished(() => ctx.fiber.dispose())

    await ctx.web.search({ query: 'before' })
    await ctx.settings.update(WEB_SEARCH_EXA_SETTINGS_NAMESPACE, {
      apiKey: 'changed-key', baseURL: `${origin}/changed`, searchType: 'neural',
      numResults: 7, highlightsPerResult: 3,
    })
    await ctx.web.search({ query: 'after' })
    await ctx.settings.replace(WEB_SEARCH_EXA_SETTINGS_NAMESPACE, {})
    await ctx.web.search({ query: 'reset' })

    expect(requests).toEqual([
      { url: '/entry/search', authorization: 'Bearer entry-key' },
      { url: '/changed/search', authorization: 'Bearer changed-key' },
      { url: '/entry/search', authorization: 'Bearer entry-key' },
    ])
    const payloads: unknown[] = []
    for (const body of await Promise.all(bodies)) {
      const payload: unknown = JSON.parse(body)
      payloads.push(payload)
    }
    expect(payloads).toEqual([
      { query: 'before', type: 'auto', contents: { highlights: { highlightsPerUrl: 1 } } },
      { query: 'after', type: 'neural', numResults: 7, contents: { highlights: { highlightsPerUrl: 3 } } },
      { query: 'reset', type: 'auto', contents: { highlights: { highlightsPerUrl: 1 } } },
    ])
    await ctx.settings.update(WEB_SEARCH_EXA_SETTINGS_NAMESPACE, { apiKey: '' })
    await expect(ctx.web.search({ query: 'disabled' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
    expect(requests).toHaveLength(3)
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

    await ctx.settings.update(WEB_SEARCH_EXA_SETTINGS_NAMESPACE, { apiKey: 'stored-key' })

    expect(section(ctx)?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    expect(JSON.stringify(section(ctx))).not.toContain('stored-key')
  })
})
