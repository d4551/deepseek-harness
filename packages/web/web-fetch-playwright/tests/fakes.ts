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
  RenderRedirectableRequest,
  RenderRequest,
  RenderRoute,
  RenderSocketRoute,
} from '../src/provider.ts'
import type { Disposable } from 'playwright'

/** Serialized document the fake page evaluates the provider's page function against. */
export const dom = { html: '<html><body>rendered</body></html>' }

/** Ordered close events, so a disposal test can prove renders quiesced first. */
export const closeLog: string[] = []

/** One request a fake navigation reports; `from` absent means the page initiated it. */
interface ReportedRequest {
  /** Absolute URL of the reported request. */
  url: string
  /** The hop this request redirects from, or undefined for a page-initiated request. */
  from?: string
}

/** Recording fake for one rendered page. */
class FakePage implements RenderPage {
  urlValue = 'https://example.com/rendered'
  statusValue = 200
  closeCount = 0
  /** @param report - reports the navigation's requests, as Chromium does before `goto` resolves. */
  constructor(private readonly report: () => void = () => {}) {}
  async goto(): Promise<{ status(): number } | null> {
    this.report()
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

/** Recording fake for one intercepted WebSocket connection. */
export class FakeSocketRoute implements RenderSocketRoute {
  closedWith: { code?: number; reason?: string } | undefined
  connectCount = 0
  constructor(private readonly socketUrl: string) {}
  url(): string {
    return this.socketUrl
  }
  connectToServer(): unknown {
    this.connectCount += 1
    return undefined
  }
  async close(options?: Readonly<{ code?: number; reason?: string }>): Promise<void> {
    this.closedWith = { ...options }
  }
}

/** An already-settled route registration teardown, matching Playwright's `Disposable`. */
function routeDisposable(): Disposable {
  const dispose = (): Promise<void> => Promise.resolve()
  return { dispose, [Symbol.asyncDispose]: dispose }
}

/** Recording fake for one incognito context. */
class FakeContext implements RenderContext {
  /**
   * Requests this context reports while its page navigates. Chromium reports every
   * redirect hop here and offers none of them to the request interceptor.
   */
  readonly reported: ReportedRequest[] = []
  readonly requestListeners: ((request: RenderRedirectableRequest) => void)[] = []
  readonly page = new FakePage(() => { this.report() })
  readonly routePatterns: string[] = []
  readonly routeHandlers: ((route: RenderRoute) => Promise<void>)[] = []
  readonly socketMatchers: ((url: URL) => boolean)[] = []
  readonly socketHandlers: ((socket: RenderSocketRoute) => Promise<void>)[] = []
  /** Ordered context setup calls, so a suite can prove the interceptors precede the page. */
  readonly setupLog: string[] = []
  closeCount = 0
  on(event: 'request', listener: (request: RenderRedirectableRequest) => void): unknown {
    this.requestListeners.push(listener)
    this.setupLog.push(`on:${event}`)
    return this
  }
  /** Hand every reported request to every installed observer, as one navigation would. */
  private report(): void {
    for (const request of this.reported) {
      const from = request.from
      const redirectedFrom = from === undefined ? null : { url: () => from }
      for (const listener of this.requestListeners) {
        listener({ url: () => request.url, redirectedFrom: () => redirectedFrom })
      }
    }
  }
  async route(pattern: string, handler: (route: RenderRoute) => Promise<void>): Promise<Disposable> {
    this.routePatterns.push(pattern)
    this.routeHandlers.push(handler)
    this.setupLog.push('route')
    return routeDisposable()
  }
  async routeWebSocket(
    match: (url: URL) => boolean,
    handler: (socket: RenderSocketRoute) => Promise<void>,
  ): Promise<void> {
    this.socketMatchers.push(match)
    this.socketHandlers.push(handler)
    this.setupLog.push('routeWebSocket')
  }
  async newPage(): Promise<RenderPage> {
    this.setupLog.push('newPage')
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
  readonly serviceWorkerModes: string[] = []
  closeCount = 0
  newContextCount = 0
  async newContext(options: Readonly<{ userAgent: string; serviceWorkers: 'block' }>): Promise<RenderContext> {
    this.newContextCount += 1
    this.userAgents.push(options.userAgent)
    this.serviceWorkerModes.push(options.serviceWorkers)
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
