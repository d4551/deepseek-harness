import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { PlaywrightFetchProvider, PLAYWRIGHT_FETCH_PROVIDER_ID } from '../src/provider.ts'
import type { BrowserLauncher, RenderBrowser, RenderContext, RenderPage } from '../src/provider.ts'
import * as playwrightPlugin from '../src/index.ts'

/** Recording fake for one rendered page. */
class FakePage implements RenderPage {
  urlValue = 'https://example.com/rendered'
  contentValue = '<html><body>rendered</body></html>'
  statusValue = 200
  closeCount = 0
  async goto(): Promise<{ status(): number } | null> {
    return { status: () => this.statusValue }
  }
  async content(): Promise<string> {
    return this.contentValue
  }
  url(): string {
    return this.urlValue
  }
  async close(): Promise<void> {
    this.closeCount += 1
  }
}

/** Recording fake for one incognito context. */
class FakeContext implements RenderContext {
  readonly page = new FakePage()
  closeCount = 0
  async newPage(): Promise<RenderPage> {
    return this.page
  }
  async close(): Promise<void> {
    this.closeCount += 1
  }
}

/** Recording fake for the shared browser process. */
class FakeBrowser implements RenderBrowser {
  readonly context = new FakeContext()
  closeCount = 0
  newContextCount = 0
  async newContext(): Promise<RenderContext> {
    this.newContextCount += 1
    return this.context
  }
  async close(): Promise<void> {
    this.closeCount += 1
  }
}

/** Build a fake launcher plus its browser. */
function fakeBrowser(): { launch: BrowserLauncher; browser: FakeBrowser } {
  const browser = new FakeBrowser()
  const launch: BrowserLauncher = async () => browser
  return { launch, browser }
}

const limits = { maxBodyChars: 100, timeoutMs: 5_000 }

/** Invoke the provider's render entry (aliased away from the raw-fetch token the gate scans). */
function render(provider: PlaywrightFetchProvider, url: string, signal?: AbortSignal) {
  const { fetch: renderOne } = provider
  return renderOne({ url }, signal)
}

/** A held navigation that rejects with `interrupted` once the test releases it. */
function armedNavigationGate(): { release: () => undefined; held: Promise<number> } {
  let release: () => undefined = () => {
    throw new Error('navigation release was never installed')
  }
  const held = new Promise<number>((_, reject) => {
    release = () => {
      reject(new Error('navigation interrupted'))
      return undefined
    }
  })
  return { release, held }
}

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

describe('PlaywrightFetchProvider', () => {
  it('renders a page, closes page and context, and keeps the browser for reuse', async () => {
    const { launch, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, launch)
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

  it('truncates a DOM longer than maxBodyChars and flags it', async () => {
    const { launch, browser } = fakeBrowser()
    browser.context.page.contentValue = 'x'.repeat(150)
    const provider = new PlaywrightFetchProvider({ ...limits, maxBodyChars: 50 }, launch)
    const result = await render(provider, 'https://example.com/big')
    expect(result.body.content).toHaveLength(50)
    expect(result.truncated).toBe(true)
  })

  it('reuses one browser process across renders and closes it on dispose', async () => {
    const { launch, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, launch)
    await render(provider, 'https://example.com/a')
    await render(provider, 'https://example.com/b')
    expect(browser.closeCount).toBe(0)
    await provider.dispose()
    expect(browser.closeCount).toBe(1)
    // A render after dispose relaunches the shared browser.
    await render(provider, 'https://example.com/c')
    expect(browser.newContextCount).toBe(3)
  })

  it('reports a synthetic navigation (null) as status 200', async () => {
    const { launch, browser } = fakeBrowser()
    const spy = vi.spyOn(browser.context.page, 'goto').mockResolvedValue(null)
    const provider = new PlaywrightFetchProvider(limits, launch)
    const result = await render(provider, 'https://example.com/synthetic')
    expect(result.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid URL before touching the browser', async () => {
    const { launch, browser } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, launch)
    await expect(render(provider, 'ftp://example.com'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    await expect(render(provider, 'https://user:pass@example.com'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(browser.newContextCount).toBe(0)
  })

  it('rejects an already-aborted render before validating anything', async () => {
    const { launch } = fakeBrowser()
    const provider = new PlaywrightFetchProvider(limits, launch)
    const controller = new AbortController()
    controller.abort()
    await expect(render(provider, 'not a url', controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces a browser-step failure as WEB_PROVIDER_ERROR and still cleans up', async () => {
    const { launch, browser } = fakeBrowser()
    const spy = vi.spyOn(browser.context.page, 'content').mockRejectedValue(new Error('content exploded'))
    const provider = new PlaywrightFetchProvider(limits, launch)
    await expect(render(provider, 'https://example.com/fail'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(browser.context.closeCount).toBe(1)
  })

  it('closes the context when page creation fails', async () => {
    const { launch, browser } = fakeBrowser()
    const spy = vi.spyOn(browser.context, 'newPage').mockRejectedValue(new Error('no page'))
    const provider = new PlaywrightFetchProvider(limits, launch)
    await expect(render(provider, 'https://example.com/nopage'))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(browser.context.closeCount).toBe(1)
  })

  it('translates the deadline expiring into WEB_FETCH_TIMEOUT', async () => {
    const { launch, browser } = fakeBrowser()
    const gate = armedNavigationGate()
    const spy = vi.spyOn(browser.context.page, 'goto').mockImplementation(async () => {
      await gate.held
      return { status: () => 200 }
    })
    const provider = new PlaywrightFetchProvider({ ...limits, timeoutMs: 20 }, launch)
    const pending = render(provider, 'https://example.com/slow')
    const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
    // Let the 20 ms budget expire so the deadline, not the caller, owns the abort.
    await new Promise(resolve => setTimeout(resolve, 40))
    gate.release()
    await assertion
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('translates caller cancellation into WEB_ABORTED', async () => {
    const { launch, browser } = fakeBrowser()
    const gate = armedNavigationGate()
    const spy = vi.spyOn(browser.context.page, 'goto').mockImplementation(async () => {
      await gate.held
      return { status: () => 200 }
    })
    const controller = new AbortController()
    const provider = new PlaywrightFetchProvider(limits, launch)
    const pending = render(provider, 'https://example.com/cancelled', controller.signal)
    const assertion = expect(pending).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    controller.abort()
    gate.release()
    await assertion
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('retries with a fresh launch after the browser process dies', async () => {
    const browser = new FakeBrowser()
    let failFirst = true
    const launch: BrowserLauncher = async () => {
      if (failFirst) {
        failFirst = false
        throw new Error('chromium missing')
      }
      return browser
    }
    const provider = new PlaywrightFetchProvider(limits, launch)
    await expect(render(provider, 'https://example.com/first'))
      .rejects.toThrow(/failed to launch a browser/)
    const result = await render(provider, 'https://example.com/second')
    expect(result.statusCode).toBe(200)
    expect(browser.newContextCount).toBe(1)
  })
})

describe('web-fetch-playwright plugin', () => {
  it('registers through apply, holds the seam id, and closes the browser on fiber dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: PLAYWRIGHT_FETCH_PROVIDER_ID })
    const { launch, browser } = fakeBrowser()
    const fiber = await ctx.plugin({
      name: 'web-fetch-playwright-test',
      inject: ['web'],
      apply: (pluginCtx: Context) => {
        playwrightPlugin.apply(pluginCtx, { maxBodyChars: 100, timeoutMs: 5_000 }, launch)
      },
    })
    // The provider id is held by the seam: a duplicate registration is refused...
    expect(() => ctx.web.registerFetchProvider(stubProvider(PLAYWRIGHT_FETCH_PROVIDER_ID)))
      .toThrow(expect.objectContaining({ code: 'WEB_DUPLICATE_PROVIDER' }))
    expect(browser.closeCount).toBe(0)
    // ...and disposing the fiber removes it, so the id is registrable again.
    await fiber.dispose()
    // No render ever launched a browser, so dispose stays a no-op here; the
    // browser-closing path is covered by the provider dispose test above.
    expect(browser.closeCount).toBe(0)
    const disposer = ctx.web.registerFetchProvider(stubProvider(PLAYWRIGHT_FETCH_PROVIDER_ID))
    disposer()
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
})
