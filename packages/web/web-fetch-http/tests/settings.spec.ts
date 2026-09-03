/** The `web-fetch-http` settings section layered over the composition entry. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as httpPlugin from '../src/index.ts'
import { WEB_FETCH_HTTP_SETTINGS_NAMESPACE } from '../src/index.ts'

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
async function boot(config: httpPlugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  const settings = ctx.plugin(MemorySettings)
  await settings.await()
  await ctx.plugin(WebRuntime, {})
  await ctx.plugin({
    name: 'web-fetch-http-settings-test',
    inject: ['web'],
    apply: (pluginCtx: Context) => {
      httpPlugin.apply(pluginCtx, httpPlugin.Config(config))
    },
  })
  return ctx
}

describe('web-fetch-http settings', () => {
  it('publishes its transport limits and declares that a change waits for the next boot', async () => {
    const ctx = await boot({ maxResponseBytes: 4_096, timeoutMs: 1_000, maxRedirects: 0 })

    const descriptor = ctx.settings.describe().find(entry => entry.ns === WEB_FETCH_HTTP_SETTINGS_NAMESPACE)

    expect(descriptor?.base).toMatchObject({ maxResponseBytes: 4_096, timeoutMs: 1_000, maxRedirects: 0 })
    expect(descriptor?.applies).toBe('restart')
  })

  it('resolves a stored section over the composition entry', async () => {
    const ctx = await boot({ maxRedirects: 5 })

    await ctx.settings.update(WEB_FETCH_HTTP_SETTINGS_NAMESPACE, { maxRedirects: 1 })

    const descriptor = ctx.settings.describe().find(entry => entry.ns === WEB_FETCH_HTTP_SETTINGS_NAMESPACE)
    expect(descriptor?.value).toMatchObject({ maxRedirects: 1 })
    expect(descriptor?.user).toEqual({ maxRedirects: 1 })
  })
})
