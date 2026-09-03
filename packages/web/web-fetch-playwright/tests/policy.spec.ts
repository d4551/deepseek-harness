import { describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { publicHttpNetwork } from '@deepseek-ai/dsh-web-fetch-http/network'
import { PlaywrightFetchProvider } from '../src/provider.ts'
import { FakeRoute, FakeSocketRoute, fakeBrowser, limits, render, sharedSetup } from './fakes.ts'

/** What the page's `close` event reports for a WebSocket the address policy refuses. */
const REFUSED_SOCKET = { code: 1008, reason: 'refused by the web fetch destination policy' }

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
    // Loopback reached from inside the page, not a redirect hop: Chromium follows a
    // redirect without re-entering this handler (tests/chromium.spec.ts pins that).
    const loopback = new FakeRoute('http://127.0.0.1:8080/internal')
    const privateName = new FakeRoute('http://10.1.2.3/admin')
    const credentialed = new FakeRoute('https://user:pass@example.com/x')
    const otherScheme = new FakeRoute('file:///etc/passwd')
    for (const route of [subresource, metadata, loopback, privateName, credentialed, otherScheme]) {
      await guard?.(route)
    }

    expect(subresource.continueCount).toBe(1)
    expect(subresource.abortedWith).toBeUndefined()
    for (const route of [metadata, loopback, privateName, credentialed, otherScheme]) {
      expect(route.abortedWith, route.request().url()).toBe('blockedbyclient')
      expect(route.continueCount, route.request().url()).toBe(0)
    }
  })

  it('admits a public IP literal without consulting DNS', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    const result = await render(provider, 'https://93.184.216.34/page')
    expect(result.statusCode).toBe(200)
    expect(publicHttpNetwork.resolve).not.toHaveBeenCalled()
    expect(browser.newContextCount).toBe(1)
  })

  it('refuses every WebSocket the page opens to a destination the policy denies', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await render(provider, 'https://example.com/page')
    const [matches] = browser.context.socketMatchers
    const [guard] = browser.context.socketHandlers
    expect(guard).toBeDefined()
    // The matcher decides which connections reach the handler: every one of them,
    // because Playwright connects an unmatched WebSocket straight to its server.
    expect(matches?.(new URL('wss://anything.example/socket'))).toBe(true)
    expect(matches?.(new URL('ws://127.0.0.1:8080/'))).toBe(true)

    const loopback = new FakeSocketRoute('ws://127.0.0.1:8080/')
    const metadata = new FakeSocketRoute('ws://169.254.169.254/latest/meta-data/')
    const privateAddress = new FakeSocketRoute('wss://10.1.2.3/admin')
    const credentialed = new FakeSocketRoute('wss://user:pass@example.com/socket')
    const otherScheme = new FakeSocketRoute('http://example.com/not-a-socket')
    const malformed = new FakeSocketRoute('not a url')
    const refused = [loopback, metadata, privateAddress, credentialed, otherScheme, malformed]
    for (const socket of refused) await guard?.(socket)

    for (const socket of refused) {
      expect(socket.closedWith, socket.url()).toEqual(REFUSED_SOCKET)
      expect(socket.connectCount, socket.url()).toBe(0)
    }
  })

  it('connects a WebSocket whose destination the policy admits, reusing the page decision', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await render(provider, 'https://example.com/page')
    const [guard] = browser.context.socketHandlers
    const socket = new FakeSocketRoute('wss://example.com/socket')
    await guard?.(socket)
    expect(socket.connectCount).toBe(1)
    expect(socket.closedWith).toBeUndefined()
    // `wss://example.com` is the host the main frame already decided.
    expect(publicHttpNetwork.resolve).toHaveBeenCalledTimes(1)
  })

  it('refuses a WebSocket to a named host whose addresses are not public', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await render(provider, 'https://example.com/page')
    vi.mocked(publicHttpNetwork.resolve).mockRejectedValue(
      new WebError('URL hostname "internal.test" resolves to a non-public IP address', 'WEB_BLOCKED_URL'),
    )
    const [guard] = browser.context.socketHandlers
    const socket = new FakeSocketRoute('wss://internal.test/socket')
    await guard?.(socket)
    expect(socket.closedWith).toEqual(REFUSED_SOCKET)
    expect(socket.connectCount).toBe(0)
  })

  it('leaves a WebSocket refusal settled when the close itself fails', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await render(provider, 'https://example.com/page')
    const [guard] = browser.context.socketHandlers
    const socket = new FakeSocketRoute('ws://127.0.0.1/')
    // A connection the page already dropped rejects the close; the handler must still
    // settle, because a handler that throws leaves Playwright's route pending.
    vi.spyOn(socket, 'close').mockRejectedValue(new Error('socket already closed'))
    await expect(guard?.(socket)).resolves.toBeUndefined()
    expect(socket.connectCount).toBe(0)
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
