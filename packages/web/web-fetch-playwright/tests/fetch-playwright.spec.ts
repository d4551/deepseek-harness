import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { PLAYWRIGHT_FETCH_PROVIDER_ID } from '../src/provider.ts'
import { dom, fakeBrowser, sharedSetup } from './fakes.ts'
import * as playwrightPlugin from '../src/index.ts'

sharedSetup()

/** Boot the composed web seam with the playwright provider wired through apply. */
async function seamWithFakeBrowser(): Promise<{
  ctx: Context
  throughSeam: (url: string) => Promise<WebFetchResult>
  setStatus: (status: number) => void
}> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { fetchProvider: PLAYWRIGHT_FETCH_PROVIDER_ID })
  const { access, browser } = fakeBrowser()
  await ctx.plugin({
    name: 'web-fetch-playwright-seam-result',
    inject: ['web'],
    apply: async (pluginCtx: Context) => {
      await playwrightPlugin.apply(pluginCtx, playwrightPlugin.Config({ maxBodyChars: 100, timeoutMs: 5_000 }), access)
    },
  })
  const seamFetch = ctx.web.fetch.bind(ctx.web)
  return {
    ctx,
    throughSeam: url => seamFetch({ url }),
    setStatus: (status) => { browser.context.page.statusValue = status },
  }
}

// The provider-level result contract is pinned in provider.spec.ts; this suite
// proves the same contract survives the composed seam (WebRuntime service +
// plugin registration), where the model-facing web_fetch call actually runs.
describe('web-fetch-playwright result contract through the seam', () => {
  it('reports the page URL after redirects as the result URL', async () => {
    const { ctx, throughSeam } = await seamWithFakeBrowser()
    // The fake page reports the post-navigation URL, as a redirect-following
    // browser would; the seam must surface it, not the requested URL.
    const result = await throughSeam('https://example.com/requested')
    expect(result.url).toBe('https://example.com/rendered')
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('html')
    expect(result.truncated).toBe(false)
    // The DOM is post-render: Chromium executed the page's scripts to produce
    // it, and the fetch card states that rather than leaving it indistinguishable
    // from bytes read over HTTP.
    expect(result.retrieval).toBe('rendered')
    await ctx.fiber.dispose()
  })

  it('returns a non-2xx main navigation as a result, not an error', async () => {
    const { ctx, throughSeam, setStatus } = await seamWithFakeBrowser()
    dom.html = '<html><body>gone</body></html>'
    setStatus(404)
    const result = await throughSeam('https://example.com/missing')
    expect(result.statusCode).toBe(404)
    expect(result.body.content).toContain('gone')
    await ctx.fiber.dispose()
  })

  it('carries the truncation flag from the rendered document through the seam', async () => {
    const { ctx, throughSeam } = await seamWithFakeBrowser()
    dom.html = 'x'.repeat(150)
    const result = await throughSeam('https://example.com/big')
    expect(result.body.content).toBe('x'.repeat(100))
    expect(result.truncated).toBe(true)
    await ctx.fiber.dispose()
  })
})
