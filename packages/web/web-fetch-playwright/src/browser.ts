/**
 * Browser ports and Chromium launch for the Playwright fetch provider. The port
 * interfaces decouple the provider from the `playwright` package so tests substitute
 * fakes for the browser process.
 * @module @deepseek-ai/dsh-web-fetch-playwright/browser
 */

import type { Disposable } from 'playwright'

/** Resolved provider limits (the plugin's schemastery Config supplies the defaults). */
export interface PlaywrightFetchLimits {
  /** Maximum rendered body length in characters; the page hands back no more than this. */
  maxBodyChars: number
  /** Per-fetch budget in milliseconds, within Node's timer range. */
  timeoutMs: number
  /** Maximum renders holding a browser context at the same time. */
  maxConcurrentRenders: number
  /** `User-Agent` every rendered request carries. */
  userAgent: string
}

/** Navigation outcome consumed by this provider: the final main-frame status code. */
export interface RenderedNavigation {
  /** HTTP status of the main-frame navigation. */
  status(): number
}

/** The serialized document a render transfers out of the page. */
export interface BoundedDom {
  /** Full serialized-document length, measured before the character cap. */
  readonly length: number
  /** The document's first `maxBodyChars` characters. */
  readonly content: string
}

/** The URL of one request the page is about to issue. */
export interface RenderRequest {
  /** Absolute URL of the intercepted request. */
  url(): string
}

/** One intercepted request, which the handler must either abort or continue. */
export interface RenderRoute {
  /** The intercepted request. */
  request(): RenderRequest
  /**
   * Refuse the request; the page observes a network failure.
   * @param errorCode - Chromium network error reported to the page.
   */
  abort(errorCode?: string): Promise<void>
  /** Send the request to the network unchanged. */
  continue(): Promise<void>
}

/** One rendered page inside an isolated context. */
export interface RenderPage {
  /** Navigate the main frame; resolves `null` for synthetic navigations. */
  goto(url: string, options: Readonly<{ timeout: number; waitUntil: 'domcontentloaded' }>): Promise<RenderedNavigation | null>
  /**
   * Run one serializable function inside the page.
   * @param pageFunction - function evaluated in the browser; it closes over nothing.
   * @param arg - the argument passed into the page.
   */
  evaluate(pageFunction: (limit: number) => BoundedDom, arg: number): Promise<BoundedDom>
  /** The page's current URL after navigation and redirects. */
  url(): string
  /** Close the page. */
  close(): Promise<void>
}

/** One incognito context; every fetch gets a fresh one. */
export interface RenderContext {
  /**
   * Install a request interceptor over every request the context issues. The
   * interceptor stays installed for the context's life; the whole context is
   * discarded after one fetch.
   * @param pattern - glob the interceptor matches request URLs against.
   * @param handler - decides each intercepted request.
   */
  route(pattern: string, handler: (route: RenderRoute) => Promise<void>): Promise<Disposable>
  /** Open the context's page. */
  newPage(): Promise<RenderPage>
  /** Close the context and everything in it. */
  close(): Promise<void>
}

/** The shared headless Chromium browser process. */
export interface RenderBrowser {
  /**
   * Open one incognito context.
   * @param options - context identity applied to every request it issues.
   */
  newContext(options: Readonly<{ userAgent: string }>): Promise<RenderContext>
  /** Close the browser process. */
  close(): Promise<void>
}

/** Opens a browser process; injected by tests, defaulted to Playwright Chromium. */
export type BrowserLauncher = () => Promise<RenderBrowser>

/** Confirms a launchable browser installation by resolving, a missing one by rejecting. */
export type BrowserProbe = () => Promise<void>

/** The browser operations this provider depends on; tests substitute fakes for both. */
export interface BrowserAccess {
  /** Open the shared browser process. */
  readonly launch: BrowserLauncher
  /** Check for a launchable browser installation without keeping a process around. */
  readonly probe: BrowserProbe
}

/**
 * Launch headless Chromium through the `playwright` package.
 * @returns the live browser process to render through.
 */
export const launchChromium: BrowserLauncher = async () => {
  const { chromium } = await import('playwright')
  return await chromium.launch({ headless: true })
}

/**
 * Confirm a launchable Chromium installation by launching one headless process and
 * closing it immediately: `playwright` exposes no on-disk probe that works across
 * hosts, and this checks exactly the operation renders depend on.
 * @returns nothing once a process launched and closed.
 */
export const probeChromium: BrowserProbe = async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  await browser.close()
}

/** Production browser access: headless Chromium through the `playwright` package. */
export const chromiumAccess: BrowserAccess = { launch: launchChromium, probe: probeChromium }

/**
 * Serialize the post-render DOM inside the page and hand back at most `limit`
 * characters plus the document's full length. Playwright evaluates this in the
 * browser, so it closes over nothing and the harness process never materializes a
 * document longer than the character cap.
 * @param limit - maximum characters to transfer out of the page.
 * @returns the document's full length and its capped prefix.
 */
export function boundedDocument(limit: number): BoundedDom {
  const html = document.documentElement.outerHTML
  return { length: html.length, content: html.slice(0, limit) }
}
