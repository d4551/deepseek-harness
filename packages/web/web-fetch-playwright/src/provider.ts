/**
 * Rendered-page `WebFetchProvider` backed by Playwright Chromium. Each fetch runs in a
 * fresh incognito browser context — no cookies, storage, or ambient credentials — and
 * returns the post-render DOM as an `html` body. One browser process serves every fetch
 * and closes with `dispose()`.
 * @module @deepseek-ai/dsh-web-fetch-playwright/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { validateFetchUrl } from '@deepseek-ai/dsh-web-fetch-http/src/policy.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies the defaults). */
export interface PlaywrightFetchLimits {
  /** Maximum rendered body length in characters; longer DOM output is truncated. */
  maxBodyChars: number
  /** Per-fetch budget in milliseconds, within Node's timer range. */
  timeoutMs: number
}

/** Navigation outcome consumed by this provider: the final main-frame status code. */
export interface RenderedNavigation {
  /** HTTP status of the main-frame navigation. */
  status(): number
}

/** One rendered page inside an isolated context. */
export interface RenderPage {
  /** Navigate the main frame; resolves `null` for synthetic navigations. */
  goto(url: string, options: Readonly<{ timeout: number; waitUntil: 'domcontentloaded' }>): Promise<RenderedNavigation | null>
  /** Serialized post-render DOM (`document.documentElement.outerHTML`). */
  content(): Promise<string>
  /** The page's current URL after navigation and redirects. */
  url(): string
  /** Close the page. */
  close(): Promise<void>
}

/** One incognito context; every fetch gets a fresh one. */
export interface RenderContext {
  newPage(): Promise<RenderPage>
  close(): Promise<void>
}

/** The shared headless Chromium browser process. */
export interface RenderBrowser {
  newContext(): Promise<RenderContext>
  close(): Promise<void>
}

/** Opens a browser process; injected by tests, defaulted to Playwright Chromium. */
export type BrowserLauncher = () => Promise<RenderBrowser>

/** Stable id this provider registers under on the fetch registry. */
export const PLAYWRIGHT_FETCH_PROVIDER_ID = 'playwright'

/** A settled asynchronous step: either its value or the rendered failure text. */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: string }

/** Mark an asynchronous step as completed with {@link Outcome.value}. */
const landed = <T>(value: T): Outcome<T> => ({ ok: true, value })

/** Mark an asynchronous step as failed with its rendered reason text. */
const failed = (failure: string): Outcome<never> => ({ ok: false, failure })

/**
 * Settle a browser step without throwing, so cleanup always runs before translation.
 * @param pending - the browser promise to settle.
 * @returns the step's value, or its rejection rendered as text.
 */
const settle = <T>(pending: Promise<T>): Promise<Outcome<T>> =>
  pending.then(landed, failed)

/**
 * Launch headless Chromium through the `playwright` package.
 * @returns the live browser process to render through.
 */
export const launchChromium: BrowserLauncher = async () => {
  const { chromium } = await import('playwright')
  return await chromium.launch({ headless: true })
}

/**
 * The Playwright-rendering fetch provider: anonymous, credential-free page rendering for
 * URLs that pass the shared fetch URL policy.
 */
export class PlaywrightFetchProvider implements WebFetchProvider {
  readonly id = PLAYWRIGHT_FETCH_PROVIDER_ID
  private browser: Promise<RenderBrowser> | undefined

  /**
   * @param limits - resolved render and time limits.
   * @param launch - browser factory; defaults to headless Chromium via `playwright`.
   */
  constructor(
    private readonly limits: PlaywrightFetchLimits,
    private readonly launch: BrowserLauncher = launchChromium,
  ) {}

  /**
   * Usable whenever enabled: the plugin is an explicit opt-in, and a missing browser
   * installation surfaces as `WEB_PROVIDER_ERROR` on first use with Playwright's install
   * guidance attached as the cause.
   */
  available(): boolean {
    return true
  }

  /** Render one URL's DOM in a fresh incognito context and return it as an `html` body. */
  readonly fetch = async (request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> => {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const url = validateFetchUrl(request.url)

    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    const browser = await this.browserOrRelaunch(d.signal)
    const opened = await settle(browser.newContext())
    if (!opened.ok) throw renderFailure(opened.failure, d.signal)
    const context = opened.value
    const pageOutcome = await settle(context.newPage())
    if (!pageOutcome.ok) {
      await settle(context.close())
      throw renderFailure(pageOutcome.failure, d.signal)
    }
    const page = pageOutcome.value
    const rendered = await this.render(page, url)
    await settle(Promise.all([page.close(), context.close()]))
    if (!rendered.ok) throw renderFailure(rendered.failure, d.signal)
    return rendered.value
  }

  /** Close the shared browser process; the next fetch launches a fresh one. */
  async dispose(): Promise<void> {
    const pending = this.browser
    this.browser = undefined
    const opened = pending === undefined ? undefined : await settle(pending)
    if (opened?.ok) await settle(opened.value.close())
  }

  /** Navigate and serialize one page's DOM under the configured limits. */
  private async render(page: RenderPage, url: URL): Promise<Outcome<WebFetchResult>> {
    const nav = await settle(page.goto(url.toString(), {
      timeout: this.limits.timeoutMs,
      waitUntil: 'domcontentloaded',
    }))
    if (!nav.ok) return failed(nav.failure)
    const dom = await settle(page.content())
    if (!dom.ok) return failed(dom.failure)
    const content = dom.value
    const truncated = content.length > this.limits.maxBodyChars
    return landed({
      url: page.url(),
      statusCode: nav.value?.status() ?? 200,
      body: { kind: 'html' as const, content: truncated ? content.slice(0, this.limits.maxBodyChars) : content },
      truncated,
    })
  }

  /**
   * Memoize the browser launch. A failed or closed launch clears the memo so the next
   * fetch retries instead of pinning a dead process.
   */
  private async browserOrRelaunch(signal: AbortSignal): Promise<RenderBrowser> {
    const onLaunchFailure = (launchFailure: Error): never => {
      this.browser = undefined
      throw new WebError(`web fetch failed to launch a browser: ${String(launchFailure)}`, 'WEB_PROVIDER_ERROR', { cause: launchFailure })
    }
    this.browser ??= this.launch().then(opened => opened, onLaunchFailure)
    const opened = await settle(this.browser)
    if (!opened.ok) throw renderFailure(opened.failure, signal)
    return opened.value
  }
}

/**
 * Translate a settled render failure using the fetch deadline's abort state: the
 * provider's timeout, caller cancellation, or a provider error.
 * @param failure - the rendered failure text from the settled step.
 * @param signal - the deadline signal governing this fetch.
 * @returns the `WebError` to throw.
 */
function renderFailure(failure: string, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED')
  return new WebError(`web fetch failed: ${failure}`, 'WEB_PROVIDER_ERROR')
}
