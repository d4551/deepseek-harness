import { describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { publicHttpNetwork } from '@deepseek-ai/dsh-web-fetch-http/network'
import { PlaywrightFetchProvider } from '../src/provider.ts'
import { FakeRoute, fakeBrowser, limits, render, sharedSetup } from './fakes.ts'

sharedSetup()

describe('PlaywrightFetchProvider destination policy', () => {
  it('refuses a loopback, link-local, or RFC1918 target before any browser work', async () => {
    const { access, browser, launchCount } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    for (const url of [
      'http://127.0.0.1:8080/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/admin',
      'http://192.168.1.1/',
      'http://[::1]/',
    ]) {
      await expect(render(provider, url), url)
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    }
    // An IP literal is decided from the literal, so the DNS policy is never consulted.
    expect(publicHttpNetwork.resolve).not.toHaveBeenCalled()
    expect(browser.newContextCount).toBe(0)
    expect(launchCount()).toBe(0)
  })

  it('refuses a named target whose addresses are not public', async () => {
    const { access, browser } = fakeBrowser()
    // What resolvePublicAddresses throws for an answer set containing a private address.
    vi.mocked(publicHttpNetwork.resolve).mockRejectedValue(
      new WebError('URL hostname "internal.test" resolves to a non-public IP address', 'WEB_BLOCKED_URL'),
    )
    const provider = new PlaywrightFetchProvider(limits, access)
    await expect(render(provider, 'https://internal.test/secret'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(browser.newContextCount).toBe(0)

    const guardedProvider = new PlaywrightFetchProvider(limits, access)
    await expect(render(guardedProvider, 'https://also-internal.test/'))
      .rejects.toThrow(/non-public IP address/)
  })

  it('intercepts every request the page issues and aborts non-public destinations', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await render(provider, 'https://example.com/page')
    expect(browser.context.routePatterns).toEqual(['**/*'])
    const [guard] = browser.context.routeHandlers
    expect(guard).toBeDefined()

    const subresource = new FakeRoute('https://static.example.com/app.js')
    const metadata = new FakeRoute('http://169.254.169.254/latest/meta-data/')
    const redirectHop = new FakeRoute('http://127.0.0.1:8080/internal')
    const privateName = new FakeRoute('http://10.1.2.3/admin')
    const credentialed = new FakeRoute('https://user:pass@example.com/x')
    const otherScheme = new FakeRoute('file:///etc/passwd')
    for (const route of [subresource, metadata, redirectHop, privateName, credentialed, otherScheme]) {
      await guard?.(route)
    }

    expect(subresource.continueCount).toBe(1)
    expect(subresource.abortedWith).toBeUndefined()
    for (const route of [metadata, redirectHop, privateName, credentialed, otherScheme]) {
      expect(route.abortedWith, route.request().url()).toBe('blockedbyclient')
      expect(route.continueCount, route.request().url()).toBe(0)
    }
  })

  it('resolves each named host once for the whole page load', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await render(provider, 'https://example.com/page')
    const [guard] = browser.context.routeHandlers
    for (const path of ['/a.js', '/b.css', '/c.png']) {
      await guard?.(new FakeRoute(`https://example.com${path}`))
    }
    // The main frame decided example.com; every subresource reuses that decision.
    expect(publicHttpNetwork.resolve).toHaveBeenCalledTimes(1)
  })
})
