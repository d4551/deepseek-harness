import { describe, expect, it, vi } from 'vitest'
import { PlaywrightFetchProvider, PLAYWRIGHT_FETCH_PROVIDER_ID } from '../src/provider.ts'
import type { BrowserAccess } from '../src/provider.ts'
import {
  armedNavigationGate,
  closeLog,
  dom,
  fakeBrowser,
  limits,
  render,
  settleQueue,
  sharedSetup,
  stallSerialization,
} from './fakes.ts'

sharedSetup()

describe('PlaywrightFetchProvider', () => {
  it('renders a page, closes page and context, and keeps the browser for reuse', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    expect(provider.id).toBe(PLAYWRIGHT_FETCH_PROVIDER_ID)
    expect(provider.available()).toBe(true)
    const first = await render(provider, 'https://example.com/page')
    expect(first.statusCode).toBe(200)
    expect(first.body.kind).toBe('html')
    expect(first.body.content).toContain('rendered')
    expect(first.url).toBe('https://example.com/rendered')
    expect(first.truncated).toBe(false)
    const second = await render(provider, 'https://example.com/again')
    expect(second.statusCode).toBe(200)
    // Each render closes its page and incognito context; one browser serves both.
    expect(browser.context.page.closeCount).toBe(2)
    expect(browser.context.closeCount).toBe(2)
    expect(browser.newContextCount).toBe(2)
    expect(browser.closeCount).toBe(0)
  })

  it('caps the DOM inside the page and flags the result as truncated', async () => {
    const { access, browser } = fakeBrowser()
    dom.html = 'x'.repeat(150)
    const evaluated = vi.spyOn(browser.context.page, 'evaluate')
    const provider = new PlaywrightFetchProvider({ ...limits, maxBodyChars: 50 }, access)
    const result = await render(provider, 'https://example.com/big')
    // The page function receives the cap, so only 50 characters ever cross into the
    // harness — the full 150-character document is never materialized here.
    expect(evaluated).toHaveBeenCalledWith(expect.any(Function), 50)
    expect(result.body.content).toBe('x'.repeat(50))
    expect(result.truncated).toBe(true)
  })

  it('does not flag a document that exactly fills the character cap', async () => {
    const { access } = fakeBrowser()
    dom.html = 'y'.repeat(50)
    const provider = new PlaywrightFetchProvider({ ...limits, maxBodyChars: 50 }, access)
    const result = await render(provider, 'https://example.com/exact')
    expect(result.body.content).toHaveLength(50)
    expect(result.truncated).toBe(false)
  })

  it('sends the configured product user agent to every context', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await render(provider, 'https://example.com/ua')
    await render(provider, 'https://example.com/ua-again')
    expect(browser.userAgents).toEqual(['test-agent/1.0', 'test-agent/1.0'])
  })

  it('reports a synthetic navigation (null) as status 200', async () => {
    const { access, browser } = fakeBrowser()
    const spy = vi.spyOn(browser.context.page, 'goto').mockResolvedValue(null)
    const provider = new PlaywrightFetchProvider(limits, access)
    const result = await render(provider, 'https://example.com/synthetic')
    expect(result.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid URL before touching the browser', async () => {
    const { access, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await expect(render(provider, 'ftp://example.com'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    await expect(render(provider, 'https://user:pass@example.com'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(browser.newContextCount).toBe(0)
  })

  it('rejects an already-aborted render before validating anything', async () => {
    const { access } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    const controller = new AbortController()
    controller.abort()
    await expect(render(provider, 'not a url', controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces a browser-step failure as WEB_PROVIDER_ERROR and still cleans up', async () => {
    const { access, browser } = fakeBrowser()
    const spy = vi.spyOn(browser.context.page, 'evaluate').mockRejectedValue(new Error('serialization exploded'))
    const provider = new PlaywrightFetchProvider(limits, access)
    await expect(render(provider, 'https://example.com/fail'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(browser.context.closeCount).toBe(1)
  })

  it('closes the context when page creation fails', async () => {
    const { access, browser } = fakeBrowser()
    const spy = vi.spyOn(browser.context, 'newPage').mockRejectedValue(new Error('no page'))
    const provider = new PlaywrightFetchProvider(limits, access)
    await expect(render(provider, 'https://example.com/nopage'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(browser.context.closeCount).toBe(1)
  })

  it('closes the context when the request interceptor cannot be installed', async () => {
    const { access, browser } = fakeBrowser()
    const spy = vi.spyOn(browser.context, 'route').mockRejectedValue(new Error('no interception'))
    const provider = new PlaywrightFetchProvider(limits, access)
    await expect(render(provider, 'https://example.com/noroute'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(browser.context.closeCount).toBe(1)
    expect(browser.context.page.closeCount).toBe(0)
  })

  it('translates the deadline expiring into WEB_FETCH_TIMEOUT', async () => {
    const { access, browser } = fakeBrowser()
    const gate = armedNavigationGate()
    const spy = vi.spyOn(browser.context.page, 'goto').mockImplementation(async () => {
      await gate.held
      return { status: () => 200 }
    })
    const provider = new PlaywrightFetchProvider({ ...limits, timeoutMs: 20 }, access)
    const pending = render(provider, 'https://example.com/slow')
    const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
    // Let the 20 ms budget expire so the deadline, not the caller, owns the abort.
    await new Promise(resolve => setTimeout(resolve, 40))
    gate.release()
    await assertion
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('gives up on a serialization that never settles and still closes page and context', async () => {
    const { access, browser } = fakeBrowser()
    stallSerialization(browser.context.page)
    const provider = new PlaywrightFetchProvider({ ...limits, timeoutMs: 20 }, access)
    await expect(render(provider, 'https://example.com/hang'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
    expect(browser.context.page.closeCount).toBe(1)
    expect(browser.context.closeCount).toBe(1)
  })

  it('gives up on a context close that never settles so the fetch still settles', async () => {
    const { access, browser } = fakeBrowser()
    vi.spyOn(browser.context, 'close').mockReturnValue(new Promise<void>(() => undefined))
    const provider = new PlaywrightFetchProvider({ ...limits, timeoutMs: 20 }, access)
    await expect(render(provider, 'https://example.com/wedged'))
      .resolves.toMatchObject({ statusCode: 200 })
  })

  it('translates caller cancellation into WEB_ABORTED', async () => {
    const { access, browser } = fakeBrowser()
    const gate = armedNavigationGate()
    const spy = vi.spyOn(browser.context.page, 'goto').mockImplementation(async () => {
      await gate.held
      return { status: () => 200 }
    })
    const controller = new AbortController()
    const provider = new PlaywrightFetchProvider(limits, access)
    const pending = render(provider, 'https://example.com/cancelled', controller.signal)
    const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    // Cancel once the render is parked in navigation, not while it is still admitting.
    await settleQueue()
    controller.abort()
    gate.release()
    await assertion
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('retries with a fresh launch after the browser process dies', async () => {
    const browser = fakeBrowser().browser
    let failFirst = true
    const access: BrowserAccess = {
      launch: async () => {
        if (failFirst) {
          failFirst = false
          throw new Error('chromium missing')
        }
        return browser
      },
      probe: async () => undefined,
    }
    const provider = new PlaywrightFetchProvider(limits, access)
    await expect(render(provider, 'https://example.com/first'))
      .rejects.toThrow(/failed to launch a browser/)
    const result = await render(provider, 'https://example.com/second')
    expect(result.statusCode).toBe(200)
    expect(browser.newContextCount).toBe(1)
  })
})

describe('PlaywrightFetchProvider limits and lifecycle', () => {
  it('bounds simultaneous contexts and hands the slot to the waiting render', async () => {
    const { access, browser } = fakeBrowser()
    const gate = armedNavigationGate()
    vi.spyOn(browser.context.page, 'goto').mockImplementationOnce(async () => {
      await gate.held
      return { status: () => 200 }
    })
    const provider = new PlaywrightFetchProvider({ ...limits, maxConcurrentRenders: 1 }, access)
    const first = render(provider, 'https://example.com/first')
    const firstAssertion = expect(first).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    const second = render(provider, 'https://example.com/second')
    await settleQueue()
    // The second render is queued behind the only slot, so it opened no context.
    expect(browser.newContextCount).toBe(1)
    gate.release()
    await firstAssertion
    await expect(second).resolves.toMatchObject({ statusCode: 200 })
    expect(browser.newContextCount).toBe(2)
  })

  it('lets a queued render give up while it waits for a slot', async () => {
    const { access, browser } = fakeBrowser()
    stallSerialization(browser.context.page)
    const provider = new PlaywrightFetchProvider({ ...limits, maxConcurrentRenders: 1 }, access)
    const holder = render(provider, 'https://example.com/holder')
    const holderAssertion = expect(holder).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    const controller = new AbortController()
    const queued = render(provider, 'https://example.com/queued', controller.signal)
    await settleQueue()
    expect(browser.newContextCount).toBe(1)
    controller.abort()
    await expect(queued).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    // The queued render never held a slot, so it never opened a context.
    expect(browser.newContextCount).toBe(1)
    await provider.dispose()
    await holderAssertion
  })

  it('refuses to fetch after dispose and launches no further browser', async () => {
    const { access, browser, launchCount } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await render(provider, 'https://example.com/a')
    await render(provider, 'https://example.com/b')
    expect(browser.closeCount).toBe(0)
    await provider.dispose()
    expect(browser.closeCount).toBe(1)
    expect(provider.available()).toBe(false)
    await expect(render(provider, 'https://example.com/c'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(launchCount()).toBe(1)
    expect(browser.newContextCount).toBe(2)
  })

  it('cancels an in-flight render before closing the browser process', async () => {
    const { access, browser } = fakeBrowser()
    stallSerialization(browser.context.page)
    const provider = new PlaywrightFetchProvider(limits, access)
    const pending = render(provider, 'https://example.com/slow')
    const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    await settleQueue()
    await provider.dispose()
    await assertion
    // The render released its page and context before the browser process closed.
    expect(closeLog).toEqual(['page.close', 'context.close', 'browser.close'])
  })

  it('reports the browser as unavailable and names the install command when the probe fails', async () => {
    const access: BrowserAccess = {
      launch: async () => { throw new Error('chromium missing') },
      probe: async () => { throw new Error('no chromium binary') },
    }
    const provider = new PlaywrightFetchProvider(limits, access)
    expect(provider.available()).toBe(true)
    await expect(provider.resolveAvailability()).resolves.toBe(false)
    expect(provider.available()).toBe(false)
    await expect(render(provider, 'https://example.com/x'))
      .rejects.toThrow(/playwright install chromium/)
  })

  it('reports the browser as available when the probe resolves', async () => {
    const { access } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, access)
    await expect(provider.resolveAvailability()).resolves.toBe(true)
    expect(provider.available()).toBe(true)
  })
})
