/**
 * Rendered-page `WebFetchProvider` backed by Playwright Chromium. Each fetch runs in a
 * fresh incognito browser context — no cookies, storage, or ambient credentials — and
 * returns the post-render DOM as an `html` body. Every request the page issues, main
 * frame and subresources alike, must pass the shared fetch URL policy and resolve to a
 * public unicast address. One browser process serves every fetch and closes with
 * `dispose()`.
 * @module @deepseek-ai/dsh-web-fetch-playwright/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { boundedDocument, chromiumAccess } from './browser.ts'
import type {
  BrowserAccess,
  PlaywrightFetchLimits,
  RenderBrowser,
  RenderPage,
} from './browser.ts'
import { DestinationPolicy, guardRequest, interceptEveryRequest } from './policy.ts'

// The browser ports live in ./browser.ts; they are re-exported here so the package
// entry (index.ts) has one public source module.
export { boundedDocument, chromiumAccess, launchChromium, probeChromium } from './browser.ts'
export type {
  BoundedDom,
  BrowserAccess,
  BrowserLauncher,
  BrowserProbe,
  PlaywrightFetchLimits,
  RenderBrowser,
  RenderContext,
  RenderPage,
  RenderRequest,
  RenderRoute,
  RenderedNavigation,
} from './browser.ts'
export { DestinationPolicy, guardRequest } from './policy.ts'

/** Stable id this provider registers under on the fetch registry. */
export const PLAYWRIGHT_FETCH_PROVIDER_ID = 'playwright'

/** The command that installs the browser this provider renders with. */
export const CHROMIUM_INSTALL_COMMAND = 'playwright install chromium'

/** Failure text recorded when a browser step outlives the fetch deadline. */
const ABANDONED_STEP = 'the browser step outlived the fetch deadline'

/** Failure text recorded when a fetch reaches a provider that has been disposed. */
const DISPOSED_PROVIDER = 'web fetch provider is disposed'

/** Failure text recorded when a queued render stops waiting for a slot. */
const ABANDONED_SLOT = 'web fetch gave up waiting for a render slot'

/** A settled asynchronous step: either its value or the error that failed it. */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Error }

/** Coerce a rejection reason into the `Error` the outcome carries. */
const asError = (reason: Error | string): Error => (typeof reason === 'string' ? new Error(reason) : reason)

/** Mark an asynchronous step as completed with {@link Outcome.value}. */
const landed = <T>(value: T): Outcome<T> => ({ ok: true, value })

/** Mark an asynchronous step as failed with its error. */
const failed = (failure: Error): Outcome<never> => ({ ok: false, failure })

/**
 * Settle a browser step without throwing, so cleanup always runs before translation.
 * @param pending - the browser promise to settle.
 * @returns the step's value, or its rejection as an error.
 */
const settle = <T>(pending: Promise<T>): Promise<Outcome<T>> =>
  pending.then(landed, (reason: Error | string) => failed(asError(reason)))

/**
 * Settle a browser step, or give up on it once the fetch deadline aborts. Playwright
 * cannot cancel a step already in flight, so an abandoned promise is left to settle
 * unobserved while the caller closes the page and context.
 * @param pending - the browser promise to settle.
 * @param signal - the deadline signal governing this fetch.
 * @returns the step's value, or the failure of the step or of the abandonment.
 */
function settleBefore<T>(pending: Promise<T>, signal: AbortSignal): Promise<Outcome<T>> {
  if (signal.aborted) return Promise.resolve(failed(new Error(ABANDONED_STEP)))
  return new Promise<Outcome<T>>((resolve) => {
    const giveUp = (): void => { resolve(failed(new Error(ABANDONED_STEP))) }
    signal.addEventListener('abort', giveUp, { once: true })
    settle(pending).then(resolve).finally(() => { signal.removeEventListener('abort', giveUp) })
  })
}

/**
 * Bounded render slots. At most `limit` fetches hold a browser context at once; the
 * rest wait in arrival order and give up when their own deadline aborts.
 */
class RenderPermits {
  private held = 0
  private readonly waiting = new Set<() => void>()

  /** @param limit - maximum permits held at the same time. */
  constructor(private readonly limit: number) {}

  /**
   * Take one permit, queueing behind earlier waiters once the limit is reached.
   * @param signal - the fetch deadline; aborting drops this waiter from the queue.
   * @returns nothing once the permit is held.
   */
  async acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error(ABANDONED_SLOT)
    if (this.held < this.limit) {
      this.held += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', giveUp)
        this.held += 1
        resolve()
      }
      const giveUp = (): void => {
        this.waiting.delete(grant)
        reject(new Error(ABANDONED_SLOT))
      }
      this.waiting.add(grant)
      signal.addEventListener('abort', giveUp, { once: true })
    })
  }

  /** Return one permit, handing it to the longest-waiting render. */
  release(): void {
    this.held -= 1
    const [next] = this.waiting
    if (next === undefined) return
    this.waiting.delete(next)
    next()
  }
}

/**
 * The Playwright-rendering fetch provider: anonymous, credential-free page rendering
 * restricted to public destinations.
 */
export class PlaywrightFetchProvider implements WebFetchProvider {
  readonly id = PLAYWRIGHT_FETCH_PROVIDER_ID
  private browser: Promise<RenderBrowser> | undefined
  private usable = true
  private disposed = false
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<WebFetchResult>>()
  private readonly permits: RenderPermits

  /**
   * @param limits - resolved render, identity, concurrency, and time limits.
   * @param access - browser launch and installation probe; defaults to Playwright Chromium.
   */
  constructor(
    private readonly limits: PlaywrightFetchLimits,
    private readonly access: BrowserAccess = chromiumAccess,
  ) {
    this.permits = new RenderPermits(limits.maxConcurrentRenders)
  }

  /**
   * Probe the browser installation once and memoize the answer. The plugin awaits
   * this before registering the provider, so {@link available} never performs I/O.
   * @returns whether a launchable browser installation was found.
   */
  async resolveAvailability(): Promise<boolean> {
    this.usable = await this.access.probe().then(() => true, () => false)
    return this.usable
  }

  /**
   * Whether a launchable browser installation was found. A provider is usable until a
   * probe proves otherwise or it is disposed; a fetch that reaches a missing
   * installation fails with the install command in its message.
   */
  available(): boolean {
    return this.usable
  }

  /** Render one URL's DOM in a fresh incognito context and return it as an `html` body. */
  readonly fetch = (request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> => {
    if (signal?.aborted) return Promise.reject(new WebError('web fetch aborted', 'WEB_ABORTED'))
    if (this.disposed) return Promise.reject(new WebError(DISPOSED_PROVIDER, 'WEB_PROVIDER_ERROR'))
    // Registration happens before the first await so dispose() cannot miss a render
    // that has already passed the disposed check.
    const running = this.renderRequest(request, signal)
    this.running.add(running)
    const forget = (): void => { this.running.delete(running) }
    running.then(forget, forget)
    return running
  }

  /**
   * Stop accepting fetches, cancel the renders in flight, and close the shared browser
   * process once they have released their pages and contexts. A disposed provider
   * never launches again.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.usable = false
    this.lifetime.abort(new Error(DISPOSED_PROVIDER))
    await Promise.allSettled([...this.running])
    const pending = this.browser
    this.browser = undefined
    const opened = pending === undefined ? undefined : await settle(pending)
    if (opened?.ok) await this.discard(opened.value.close())
  }

  /**
   * Close browser resources under a fresh copy of the fetch budget. The fetch deadline
   * that reached cleanup has usually already expired, and a wedged browser must not
   * hold a fetch — or this provider's disposal — open forever.
   * @param closing - the close operations to await.
   * @returns nothing once the operations settle or the budget elapses.
   */
  private async discard(closing: Promise<void>): Promise<void> {
    using closed = deadline(undefined, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    await settleBefore(closing, closed.signal)
  }

  /** Validate, admit, and render one request under its own deadline and render slot. */
  private async renderRequest(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    // The provider's lifetime signal joins the caller's, so dispose() settles every
    // render in flight instead of closing the browser underneath it.
    const upstream = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    using d = deadline(upstream, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    const policy = new DestinationPolicy(d.signal)
    // The main frame is admitted before any browser work, so a refused target reports
    // its own code instead of a navigation failure.
    const admittedMain = await settle(policy.admit(request.url))
    if (!admittedMain.ok) {
      throw admittedMain.failure instanceof WebError
        ? admittedMain.failure
        : renderFailure(admittedMain.failure, d.signal)
    }
    const url = admittedMain.value

    const admitted = await settle(this.permits.acquire(d.signal))
    if (!admitted.ok) throw renderFailure(admitted.failure, d.signal)
    const release = (): void => { this.permits.release() }
    return await this.renderAdmitted(url, policy, d.signal).then(
      (value: WebFetchResult) => { release(); return value },
      (failure: Error | string) => { release(); throw asError(failure) },
    )
  }

  /** Open a context, guard its requests, render, and close the page and context. */
  private async renderAdmitted(url: URL, policy: DestinationPolicy, signal: AbortSignal): Promise<WebFetchResult> {
    const browser = await this.browserOrRelaunch(signal)
    const opened = await settleBefore(browser.newContext({ userAgent: this.limits.userAgent }), signal)
    if (!opened.ok) throw renderFailure(opened.failure, signal)
    const context = opened.value
    const guarded = await settleBefore(context.route(interceptEveryRequest, guardRequest(policy)), signal)
    if (!guarded.ok) {
      await this.discard(context.close())
      throw renderFailure(guarded.failure, signal)
    }
    const pageOutcome = await settleBefore(context.newPage(), signal)
    if (!pageOutcome.ok) {
      await this.discard(context.close())
      throw renderFailure(pageOutcome.failure, signal)
    }
    const page = pageOutcome.value
    const rendered = await this.render(page, url, signal)
    await this.discard(page.close().then(() => context.close()))
    if (!rendered.ok) throw renderFailure(rendered.failure, signal)
    return rendered.value
  }

  /** Navigate and serialize one page's DOM under the configured limits. */
  private async render(page: RenderPage, url: URL, signal: AbortSignal): Promise<Outcome<WebFetchResult>> {
    const nav = await settleBefore(page.goto(url.toString(), {
      timeout: this.limits.timeoutMs,
      waitUntil: 'domcontentloaded',
    }), signal)
    if (!nav.ok) return failed(nav.failure)
    const dom = await settleBefore(page.evaluate(boundedDocument, this.limits.maxBodyChars), signal)
    if (!dom.ok) return failed(dom.failure)
    return landed({
      url: page.url(),
      statusCode: nav.value?.status() ?? 200,
      body: { kind: 'html' as const, content: dom.value.content },
      truncated: dom.value.length > this.limits.maxBodyChars,
    })
  }

  /**
   * Memoize the browser launch. A disposed provider refuses to launch, so a fetch that
   * raced dispose fails instead of starting a process nothing will close; a failed or
   * closed launch clears the memo so the next fetch retries instead of pinning a dead
   * process.
   */
  private async browserOrRelaunch(signal: AbortSignal): Promise<RenderBrowser> {
    if (this.disposed) throw new WebError(DISPOSED_PROVIDER, 'WEB_PROVIDER_ERROR')
    const onLaunchFailure = (launchFailure: Error): never => {
      this.browser = undefined
      throw new WebError(
        `web fetch failed to launch a browser: ${String(launchFailure)}; install one with "${CHROMIUM_INSTALL_COMMAND}"`,
        'WEB_PROVIDER_ERROR',
        { cause: launchFailure },
      )
    }
    this.browser ??= this.access.launch().then(opened => opened, onLaunchFailure)
    const opened = await settle(this.browser)
    if (!opened.ok) throw renderFailure(opened.failure, signal)
    return opened.value
  }
}

/**
 * Translate a settled render failure using the fetch deadline's abort state: the
 * provider's timeout, caller cancellation, or a provider error.
 * @param failure - the settled failure from the browser step.
 * @param signal - the deadline signal governing this fetch.
 * @returns the `WebError` to throw.
 */
function renderFailure(failure: Error, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED')
  return new WebError(`web fetch failed: ${failure.message}`, 'WEB_PROVIDER_ERROR')
}
