import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http/policy'
import { PLAYWRIGHT_FETCH_PROVIDER_ID } from '../src/provider.ts'
import { fakeBrowser } from './fakes.ts'
import * as playwrightPlugin from '../src/index.ts'

/** Minimal stand-in provider used to probe the web seam's registry state. */
function stubProvider(id: string): WebFetchProvider {
  const provider: WebFetchProvider = {
    id,
    available: () => true,
    fetch: async (request: WebFetchRequest): Promise<WebFetchResult> => ({
      url: request.url,
      statusCode: 200,
      body: { kind: 'text', content: 'stub' },
      truncated: false,
    }),
  }
  return provider
}

/** Issue a fetch through the web seam service (the shared web capability API layer). */
function throughSeam(ctx: Context): (url: string) => Promise<WebFetchResult> {
  // Bind the seam method to its service so the call keeps the registry context.
  const seamFetch = ctx.web.fetch.bind(ctx.web)
  return (url: string) => seamFetch({ url })
}

describe('web-fetch-playwright plugin', () => {
  it('registers through apply, holds the seam id, and closes the browser on fiber dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: PLAYWRIGHT_FETCH_PROVIDER_ID })
    const { access, browser } = fakeBrowser()
    const fiber = await ctx.plugin({
      name: 'web-fetch-playwright-test',
      inject: ['web'],
      apply: async (pluginCtx: Context) => {
        await playwrightPlugin.apply(pluginCtx, playwrightPlugin.Config({ maxBodyChars: 100, timeoutMs: 5_000 }), access)
      },
    })
    // The provider id is held by the seam: a duplicate registration is refused...
    expect(() => ctx.web.registerFetchProvider(stubProvider(PLAYWRIGHT_FETCH_PROVIDER_ID)))
      .toThrow(expect.objectContaining({ code: 'WEB_DUPLICATE_PROVIDER' }))
    await throughSeam(ctx)('https://example.com/through-the-seam')
    expect(browser.newContextCount).toBe(1)
    expect(browser.closeCount).toBe(0)
    // ...and disposing the fiber removes it, closing the shared browser.
    await fiber.dispose()
    expect(browser.closeCount).toBe(1)
    const disposer = ctx.web.registerFetchProvider(stubProvider(PLAYWRIGHT_FETCH_PROVIDER_ID))
    disposer()
  })

  it('defaults the rendered user agent to the shared product agent', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: PLAYWRIGHT_FETCH_PROVIDER_ID })
    const { access, browser } = fakeBrowser()
    await ctx.plugin({
      name: 'web-fetch-playwright-default-agent',
      inject: ['web'],
      apply: async (pluginCtx: Context) => {
        await playwrightPlugin.apply(pluginCtx, playwrightPlugin.Config({}), access)
      },
    })
    await throughSeam(ctx)('https://example.com/agent')
    expect(browser.userAgents).toEqual([DEFAULT_USER_AGENT])
  })

  it('leaves the provider unusable when no browser installation is found', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: PLAYWRIGHT_FETCH_PROVIDER_ID })
    await ctx.plugin({
      name: 'web-fetch-playwright-missing-browser',
      inject: ['web'],
      apply: async (pluginCtx: Context) => {
        await playwrightPlugin.apply(pluginCtx, playwrightPlugin.Config({}), {
          launch: async () => { throw new Error('chromium missing') },
          probe: async () => { throw new Error('no chromium binary') },
        })
      },
    })
    await expect(throughSeam(ctx)('https://example.com/x'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('rejects a non-positive maxBodyChars at plugin apply time', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: PLAYWRIGHT_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(playwrightPlugin, { maxBodyChars: 0 }))
      .rejects.toThrow(/maxBodyChars must be a positive finite number/)
  })

  it('rejects a timeoutMs above the Node timer ceiling at plugin apply time', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: PLAYWRIGHT_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(playwrightPlugin, { timeoutMs: 2_147_483_648 }))
      .rejects.toThrow(/timeoutMs must be no greater than/)
  })

  it('rejects a fractional or non-positive maxConcurrentRenders at plugin apply time', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: PLAYWRIGHT_FETCH_PROVIDER_ID })
    await expect(ctx.plugin(playwrightPlugin, { maxConcurrentRenders: 1.5 }))
      .rejects.toThrow(/maxConcurrentRenders must be a positive integer/)
    await expect(ctx.plugin(playwrightPlugin, { maxConcurrentRenders: 0 }))
      .rejects.toThrow(/maxConcurrentRenders must be a positive integer/)
  })
})
