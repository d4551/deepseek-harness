import { afterEach, describe, expect, it } from 'vitest'
import { WEB_FETCH_USER_AGENT } from '@deepseek-ai/dsh-web'
import { PlaywrightFetchProvider } from '../src/provider.ts'

const providers: PlaywrightFetchProvider[] = []
afterEach(async () => {
  await Promise.all(providers.splice(0).map(provider => provider.dispose()))
})

describe('live Chromium browser search', () => {
  it('returns real Bing citations without search credentials', async () => {
    const provider = new PlaywrightFetchProvider({
      maxBodyChars: 100_000,
      timeoutMs: 30_000,
      maxConcurrentRenders: 2,
      userAgent: WEB_FETCH_USER_AGENT,
    })
    providers.push(provider)
    expect(await provider.resolveAvailability()).toBe(true)
    const result = await provider.search({ query: 'TypeScript compiler API', maxResults: 3 })
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources.length).toBeLessThanOrEqual(3)
    for (const source of result.sources) {
      expect(source.url).toMatch(/^https?:\/\//)
      expect(source.title?.length).toBeGreaterThan(0)
      expect(new URL(source.url).pathname).not.toBe('/ck/a')
    }
    expect(result.content).toBeUndefined()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(provider.search({ query: 'cancelled search' }, cancelled.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    await provider.dispose()
    await expect(provider.search({ query: 'disposed search' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})
