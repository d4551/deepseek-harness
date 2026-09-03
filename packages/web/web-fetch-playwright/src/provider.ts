/**
 * Rendered-page `WebFetchProvider` backed by Playwright Chromium. Each fetch runs in a
 * fresh incognito browser context — no cookies, storage, or ambient credentials — and
 * returns the post-render DOM as an `html` body. Every request the page initiates, main
 * frame and subresources alike, every hop a redirect names, and every WebSocket its
 * pages and frames open must pass the shared fetch URL policy and reach a public unicast
 * address. The three arrive on three Playwright channels and the context installs all
 * three: the request interceptor, the WebSocket interceptor, and the context's own
 * `request` observer, which is where a redirect hop appears because Chromium follows one
 * without re-entering the interceptor. One browser process serves every fetch and closes
 * with `dispose()`.
 * @module @deepseek-ai/dsh-web-fetch-playwright/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { CapacityGate } from '@deepseek-ai/dsh-capacity-gate'
import type { CapacityRelease } from '@deepseek-ai/dsh-capacity-gate'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { boundedDocument, chromiumAccess, chromiumInstallCommand } from './browser.ts'
import type {
  BrowserAccess,
  BrowserSelection,
  PlaywrightFetchLimits,
  RenderBrowser,
  RenderContext,
  RenderPage,
  RenderRedirectableRequest,
} from './browser.ts'
import {
  DestinationPolicy,
  guardRequest,
  guardSocket,
  interceptEveryRequest,
  interceptEverySocket,
} from './policy.ts'

// The browser ports live in ./browser.ts; they are re-exported here so the package
// entry (index.ts) has one public source module.
export {
  boundedDocument,
  chromiumAccess,
  chromiumExecutablePath,
  chromiumInstallCommand,
  launchChromium,
  playwrightInstallCommand,
  probeChromium,
  probeExecutable,
} from './browser.ts'
export type {
  BoundedDom,
  BrowserAccess,
  BrowserLauncher,
  BrowserProbe,
  BrowserSelection,
  ExecutableLocator,
  ModuleResolver,
  PlaywrightFetchLimits,
  RenderBrowser,
  RenderContext,
  RenderPage,
  RenderRedirectableRequest,
  RenderRequest,
  RenderRoute,
  RenderSocketRoute,
  RenderedNavigation,
} from './browser.ts'
export {
  DestinationPolicy,
  guardRequest,
  guardSocket,
  interceptEveryRequest,
  interceptEverySocket,
} from './policy.ts'

/** Stable id this provider registers under on the fetch registry. */
export const PLAYWRIGHT_FETCH_PROVIDER_ID = 'playwright'

/** Failure text recorded when a browser step outlives the fetch deadline. */
const ABANDONED_STEP = 'the browser step outlived the fetch deadline'

/** Failure text recorded when a fetch reaches a provider that has been disposed. */
const DISPOSED_PROVIDER = 'web fetch provider is disposed'

/** A settled asynchronous step: either its value or the error that failed it. */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Error }

/** Mark an asynchronous step as completed with {@link Outcome.value}. */
const landed = <T>(value: T): Outcome<T> => ({ ok: true, value })

/** Mark an asynchronous step as failed with its error. */
const failed = (failure: Error): Outcome<never> => ({ ok: false, failure })

/**
 * Settle a browser step without throwing, so cleanup always runs before translation.
 * @param pending - the browser promise to settle.
 * @returns the step's value, or its rejection as an error.
 */
async function settle<T>(pending: Promise<T>): Promise<Outcome<T>> {
  const [outcome] = await Promise.allSettled([pending])
  return outcome.status === 'fulfilled'
    ? landed(outcome.value)
    : failed(outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)))
}

/**
 * Settle a browser step, or give up on it once the fetch deadline aborts. Playwright
 * cannot cancel a step already in flight, so an abandoned promise is left to settle
 * unobserved while the caller closes the page and context. The once-listener detaches
 * itself when the disposed deadline signal aborts.
 * @param pending - the browser promise to settle.
 * @param signal - the deadline signal governing this fetch.
 * @returns the step's value, or the failure of the step or of the abandonment.
 */
async function settleBefore<T>(pending: Promise<T>, signal: AbortSignal): Promise<Outcome<T>> {
  if (signal.aborted) return failed(new Error(ABANDONED_STEP))
  const abandonment = new Promise<Outcome<T>>((resolve) => {
    const giveUp = (): void => { resolve(failed(new Error(ABANDONED_STEP))) }
    signal.addEventListener('abort', giveUp, { once: true })
  })
  return await Promise.race([settle(pending), abandonment])
}

/**
 * The decisions taken on the hops one fetch's context followed on its own. Chromium
 * reports a redirect hop as a request carrying `redirectedFrom()` and never offers it to
 * the request interceptor, so the hops are decided here instead — measured against
 * Chromium 1.62.1: every hop of a navigation chain is reported before `goto` resolves.
 */
interface RedirectAudit {
  /**
   * Start deciding one reported request. A request the page initiated is skipped: the
   * request interceptor already decided that one, and refusing it there aborts the
   * single request rather than the fetch. A closure rather than a method, because the
   * context takes it as a standalone listener.
   */
  readonly observe: (request: RenderRedirectableRequest) => void
  /** Settle every decision started so far into nothing, or the first refusal. */
  readonly settle: () => Promise<Outcome<void>>
}

/**
 * Audit the redirect hops one fetch follows, under the fetch's own destination policy.
 * A refused hop fails the whole fetch rather than one request, because the page has
 * already received that hop's response by the time it is reported; settling before the
 * DOM is read is what keeps its bytes from reaching the caller.
 * @param policy - the fetch's destination policy, whose per-hostname memo the hops share.
 * @returns the audit to install on the context's request observer.
 */
function auditRedirects(policy: DestinationPolicy): RedirectAudit {
  const decided: Promise<Outcome<URL>>[] = []
  return {
    observe: (request: RenderRedirectableRequest): void => {
      if (request.redirectedFrom() === null) return
      decided.push(settle(policy.admit(request.url())))
    },
    settle: async (): Promise<Outcome<void>> => {
      for (const outcome of await Promise.all(decided)) {
        if (!outcome.ok) return failed(outcome.failure)
      }
      return landed(undefined)
    },
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
  /** Executable the last probe confirmed; undefined until one has, or once none did. */
  private executable: string | undefined
  private disposed = false
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<WebFetchResult>>()
  /** Render slots: at most `maxConcurrentRenders` fetches hold a browser context at once. */
  private readonly permits: CapacityGate

  /**
   * @param limits - resolved render, identity, concurrency, and time limits, plus the browser binary to run.
   * @param access - browser launch and installation probe; defaults to Playwright Chromium.
   */
  constructor(
    private readonly limits: PlaywrightFetchLimits,
    private readonly access: BrowserAccess = chromiumAccess,
  ) {
    this.permits = new CapacityGate(limits.maxConcurrentRenders)
  }

  /**
   * Probe the browser installation once and memoize the answer. The plugin awaits this
   * before registering the provider, so {@link available} never performs I/O.
   * @returns whether an installed browser was found.
   */
  async resolveAvailability(): Promise<boolean> {
    this.executable = await this.access.probe(this.selection()).then(
      confirmed => confirmed,
      () => undefined,
    )
    this.usable = this.executable !== undefined
    return this.usable
  }

  /**
   * The browser executable the probe confirmed, which the plugin publishes so a
   * configuration surface can name the binary this provider renders with.
   * @returns the confirmed absolute path, or undefined when no installation was found.
   */
  browserExecutable(): string | undefined {
    return this.executable
  }

  /** The browser binary every probe and launch of this provider applies to. */
  private selection(): BrowserSelection {
    return this.limits.executablePath === undefined
      ? {}
      : { executablePath: this.limits.executablePath }
  }

  /**
   * Whether an installed browser was found. A provider is usable until a probe proves
   * otherwise or it is disposed; a fetch that reaches an installation the probe passed
   * but that cannot start fails with the launch error and the install command in its
   * message.
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
   * process once they have released their pages and contexts. The memo is read after
   * those renders settle, so a process one of them opened while disposal waited is
   * closed too. A disposed provider accepts no further fetch.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.usable = false
    this.lifetime.abort(new Error(DISPOSED_PROVIDER))
    await Promise.allSettled([...this.running])
    const pending = this.browser
    this.browser = undefined
    if (pending === undefined) return
    // A launch that failed cleared the memo itself, so a memo that survives to here is
    // a process to close; discard() settles a close that fails or wedges, which is what
    // keeps this method total — the plugin's disposer has no failure to report.
    await this.discard(pending.then(browser => browser.close()))
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

    const admitted = await settle(this.admitRender(d.signal))
    if (!admitted.ok) throw renderFailure(admitted.failure, d.signal)
    const release = admitted.value
    const rendered = await settle(this.renderAdmitted(url, policy, d.signal))
    release()
    if (!rendered.ok) throw renderFailure(rendered.failure, d.signal)
    return rendered.value
  }

  /**
   * Take one render slot under the fetch deadline. The gate grants a free slot without
   * reading the signal, so refusing a fetch whose budget is already spent stays this
   * provider's own rule: such a fetch must open no browser context.
   * @param signal - the deadline signal governing this fetch.
   * @returns the idempotent release for the granted slot.
   */
  private async admitRender(signal: AbortSignal): Promise<CapacityRelease> {
    signal.throwIfAborted()
    return await this.permits.acquire(signal)
  }

  /**
   * Install every destination check the context needs. Playwright reports the three
   * kinds of destination a rendered page reaches on three channels: HTTP requests the
   * page initiates through the request interceptor, WebSocket connections through their
   * own interceptor — an unrouted one is connected straight to its server — and the hops
   * a redirect names through the context's `request` observer alone. A context missing
   * any of the three lets a rendered page reach a host the policy would refuse.
   * @param context - the fresh incognito context.
   * @param policy - the fetch's destination policy.
   * @param signal - the deadline signal governing this fetch.
   * @returns the redirect audit once all three are installed, or the failure that stopped one.
   */
  private async guardContext(
    context: RenderContext,
    policy: DestinationPolicy,
    signal: AbortSignal,
  ): Promise<Outcome<RedirectAudit>> {
    // The observer goes on first: it is synchronous, and it is the only channel that
    // reports a redirect hop at all.
    const audit = auditRedirects(policy)
    context.on('request', audit.observe)
    const requests = await settleBefore(context.route(interceptEveryRequest, guardRequest(policy)), signal)
    if (!requests.ok) return failed(requests.failure)
    const sockets = await settleBefore(context.routeWebSocket(interceptEverySocket, guardSocket(policy)), signal)
    if (!sockets.ok) return failed(sockets.failure)
    return landed(audit)
  }

  /** Open a context, guard its requests and sockets, render, and close the page and context. */
  private async renderAdmitted(url: URL, policy: DestinationPolicy, signal: AbortSignal): Promise<WebFetchResult> {
    const browser = await this.browserOrRelaunch(signal)
    const identity = { userAgent: this.limits.userAgent, serviceWorkers: 'block' } as const
    const opened = await settleBefore(browser.newContext(identity), signal)
    if (!opened.ok) throw renderFailure(opened.failure, signal)
    const context = opened.value
    // Both interceptors are installed before the context has a page: a WebSocket the
    // page opens first would otherwise reach its server unrouted.
    const guarded = await this.guardContext(context, policy, signal)
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
    const rendered = await this.render(page, url, guarded.value, signal)
    await this.discard(page.close().then(() => context.close()))
    if (!rendered.ok) throw renderFailure(rendered.failure, signal)
    return rendered.value
  }

  /** Navigate and serialize one page's DOM under the configured limits. */
  private async render(
    page: RenderPage,
    url: URL,
    audit: RedirectAudit,
    signal: AbortSignal,
  ): Promise<Outcome<WebFetchResult>> {
    const nav = await settleBefore(page.goto(url.toString(), {
      timeout: this.limits.timeoutMs,
      waitUntil: 'domcontentloaded',
    }), signal)
    if (!nav.ok) return failed(nav.failure)
    // Every hop the navigation followed is reported before `goto` resolves, and this is
    // the last point before the document is read: a refused hop fails the fetch with the
    // policy's own code, so no byte of a page that reached a refused address is returned.
    const hops = await audit.settle()
    if (!hops.ok) return failed(hops.failure)
    const dom = await settleBefore(page.evaluate(boundedDocument, this.limits.maxBodyChars), signal)
    if (!dom.ok) return failed(dom.failure)
    return landed({
      url: page.url(),
      statusCode: nav.value?.status() ?? 200,
      body: { kind: 'html' as const, content: dom.value.content },
      truncated: dom.value.length > this.limits.maxBodyChars,
      // The returned DOM is post-render: Chromium executed the page's scripts
      // and issued the subresource requests they asked for, all under the same
      // destination policy. That is a different act from reading bytes, and a
      // reader of the transcript is entitled to know which one happened.
      retrieval: 'rendered',
    })
  }

  /**
   * Memoize the browser launch. A failed or closed launch clears the memo so the next
   * fetch retries instead of pinning a dead process. A launch that races `dispose()` is
   * closed by it: `dispose()` waits for every render in flight before reading the memo,
   * so a process opened during that wait is still the one it closes.
   */
  private async browserOrRelaunch(signal: AbortSignal): Promise<RenderBrowser> {
    const onLaunchFailure = (launchFailure: Error): never => {
      this.browser = undefined
      throw new WebError(
        `web fetch failed to launch a browser: ${String(launchFailure)}; install one with: ${chromiumInstallCommand()}`,
        'WEB_PROVIDER_ERROR',
        { cause: launchFailure },
      )
    }
    this.browser ??= this.access.launch(this.selection()).then(opened => opened, onLaunchFailure)
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
  // A `WebError` raised inside the render step is already translated: it
  // carries the seam code the caller switches on. Wrapping it again would
  // report a blocked destination as a generic provider error and prefix the
  // message a second time.
  if (failure instanceof WebError) return failure
  return new WebError(`web fetch failed: ${failure.message}`, 'WEB_PROVIDER_ERROR')
}
