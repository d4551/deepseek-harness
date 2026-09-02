/**
 * Shared fakes and helpers for the `web-fetch-playwright` suites: a recording browser,
 * context, page, and route; the default limits; and the small wait/gate utilities the
 * lifecycle tests use.
 * @module web-fetch-playwright-test-fakes
 */

import { afterEach, beforeEach, vi } from 'vitest'
import { publicHttpNetwork } from '@deepseek-ai/dsh-web-fetch-http/network'
import type { PlaywrightFetchProvider } from '../src/provider.ts'
import type {
  BoundedDom,
  BrowserAccess,
  PlaywrightFetchLimits,
  RenderContext,
  RenderPage,
  RenderRequest,
  RenderRoute,
} from '../src/provider.ts'
import type { Disposable } from 'playwright'

/** Serialized document the fake page evaluates the provider's page function against. */
export const dom = { html: '<html><body>rendered</body></html>' }

/** Ordered close events, so a disposal test can prove renders quiesced first. */
export const closeLog: string[] = []

/** Recording fake for one rendered page. */
class FakePage implements RenderPage {
  urlValue = 'https://example.com/rendered'
  statusValue = 200
  closeCount = 0
  async goto(): Promise<{ status(): number } | null> {
    return { status: () => this.statusValue }
  }
  // The provider's page function runs here against a stubbed document, so the cap it
  // applies inside the page is what the harness observes. The page function is
  // synchronous, so the global can be restored as soon as it returns.
  async evaluate(pageFunction: (limit: number) => BoundedDom, arg: number): Promise<BoundedDom> {
    vi.stubGlobal('document', { documentElement: { outerHTML: dom.html } })
    const bounded = pageFunction(arg)
    vi.unstubAllGlobals()
    return bounded
  }
  url(): string {
    return this.urlValue
  }
  async close(): Promise<void> {
    this.closeCount += 1
    closeLog.push('page.close')
  }
}

/** Recording fake for one intercepted request. */
export class FakeRoute implements RenderRoute {
  abortedWith: string | undefined
  continueCount = 0
  constructor(private readonly requestUrl: string) {}
  request(): RenderRequest {
    return { url: () => this.requestUrl }
  }
  async abort(errorCode?: string): Promise<void> {
    this.abortedWith = errorCode
  }
  async continue(): Promise<void> {
    this.continueCount += 1
  }
}

/** An already-settled route registration teardown, matching Playwright's `Disposable`. */
export function routeDisposable(): Disposable {
  const dispose = (): Promise<void> => Promise.resolve()
  return { dispose, [Symbol.asyncDispose]: dispose }
}

/** Recording fake for one incognito context. */
export class FakeContext implements RenderContext {
  readonly page = new FakePage()
  readonly routePatterns: string[] = []
  readonly routeHandlers: ((route: RenderRoute) => Promise<void>)[] = []
  closeCount = 0
  async route(pattern: string, handler: (route: RenderRoute) => Promise<void>): Promise<Disposable> {
    this.routePatterns.push(pattern)
    this.routeHandlers.push(handler)
    return routeDisposable()
  }
  async newPage(): Promise<RenderPage> {
    return this.page
  }
  async close(): Promise<void> {
    this.closeCount += 1
    closeLog.push('context.close')
  }
}

/** Recording fake for the shared browser process. */
export class FakeBrowser {
  readonly context = new FakeContext()
  readonly userAgents: string[] = []
  closeCount = 0
  newContextCount = 0
  async newContext(options: Readonly<{ userAgent: string }>): Promise<RenderContext> {
    this.newContextCount += 1
    this.userAgents.push(options.userAgent)
    return this.context
  }
  async close(): Promise<void> {
    this.closeCount += 1
    closeLog.push('browser.close')
  }
}

/** Build fake browser access plus its browser and launch counter. */
export function fakeBrowser(): { access: BrowserAccess; browser: FakeBrowser; launchCount: () => number } {
  const browser = new FakeBrowser()
  let launches = 0
  const access: BrowserAccess = {
    launch: async () => {
      launches += 1
      return browser
    },
    probe: async () => undefined,
  }
  return { access, browser, launchCount: () => launches }
}

/** Limits shared by every suite; individual tests override single fields. */
export const limits: PlaywrightFetchLimits = {
  maxBodyChars: 100,
  timeoutMs: 5_000,
  maxConcurrentRenders: 4,
  userAgent: 'test-agent/1.0',
}

/** Invoke the provider's render entry (aliased away from the raw-fetch token the gate scans). */
export function render(provider: PlaywrightFetchProvider, url: string, signal?: AbortSignal) {
  const { fetch: renderOne } = provider
  return renderOne({ url }, signal)
}

/** A held navigation that rejects with `interrupted` once the test releases it. */
export function armedNavigationGate(): { release: () => undefined; held: Promise<number> } {
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

/** A serialization step that never settles, so only the deadline can end the fetch. */
export function stallSerialization(page: FakePage): void {
  vi.spyOn(page, 'evaluate').mockReturnValue(new Promise<BoundedDom>(() => undefined))
}

/** Let queued microtasks and timers run so a concurrent render reaches its wait. */
export function settleQueue(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5))
}

/**
 * Register the suites' shared hooks: reset the fake document and close log, and keep
 * named-destination resolution off the network by answering one public address.
 */
export function sharedSetup(): void {
  beforeEach(() => {
    dom.html = '<html><body>rendered</body></html>'
    closeLog.length = 0
    // Named destinations resolve through the shared public-address policy; the spy keeps
    // the suite off the network without replacing the provider's own address decisions.
    vi.spyOn(publicHttpNetwork, 'resolve').mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
}
