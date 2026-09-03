/**
 * Browser ports and Chromium access for the Playwright fetch provider. The port
 * interfaces decouple the provider from the `playwright` package so tests substitute
 * fakes for the browser process. Every port method is structurally satisfied by the
 * real Playwright object the launcher returns, so the compiler rejects a port that
 * drifts from the API the provider depends on.
 * @module @deepseek-ai/dsh-web-fetch-playwright/browser
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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

/**
 * One request the context reported, carrying the request it redirects from. Chromium
 * follows a redirect inside its own network stack without re-entering the request
 * interceptor, so this is the only place a hop a redirect names can be decided.
 */
export interface RenderRedirectableRequest extends RenderRequest {
  /**
   * The request this one redirects from, or `null` when the page initiated it.
   * @returns the previous hop, which the request interceptor already decided.
   */
  redirectedFrom(): RenderRequest | null
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

/**
 * One intercepted WebSocket connection, which the handler must either connect to its
 * server or close. An intercepted connection reaches no server until
 * {@link RenderSocketRoute.connectToServer} is called.
 */
export interface RenderSocketRoute {
  /** Absolute `ws:` or `wss:` URL the page opened. */
  url(): string
  /**
   * Connect the page's socket to the real server, restoring ordinary WebSocket traffic.
   * @returns the server-side route, which this provider does not use.
   */
  connectToServer(): unknown
  /**
   * Close the page's side of the connection without reaching any server.
   * @param options - close code and reason the page's `close` event reports.
   * @returns nothing once the page observes the closure.
   */
  close(options?: Readonly<{ code?: number; reason?: string }>): Promise<void>
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
   * Observe every request the context reports, including the hops Chromium follows on
   * its own. The request interceptor never sees those hops, so this observer is where
   * the address policy decides them; it is installed before the context has a page.
   * @param event - the only context event this provider observes.
   * @param listener - receives each reported request; a hop carries `redirectedFrom()`.
   * @returns the context, which this provider does not use.
   */
  on(event: 'request', listener: (request: RenderRedirectableRequest) => void): unknown
  /**
   * Install a request interceptor over every request the context's pages initiate. The
   * interceptor stays installed for the context's life; the whole context is discarded
   * after one fetch. Chromium follows a redirect without re-entering it, so the hop a
   * redirect names arrives at {@link RenderContext.on} instead.
   * @param pattern - glob the interceptor matches request URLs against.
   * @param handler - decides each intercepted request.
   * @returns the registration's teardown, which the discarded context makes unnecessary.
   */
  route(pattern: string, handler: (route: RenderRoute) => Promise<void>): Promise<Disposable>
  /**
   * Install a WebSocket interceptor over the connections a page or frame opens.
   * Playwright routes WebSockets through this API alone: a connection no handler matches
   * is connected straight to its server, and only connections opened after the handler
   * is installed are routed, so this runs before the context has a page. Playwright
   * routes no WebSocket a dedicated worker opens, at the page level or here; the
   * package README records that gap under its known limitations.
   * @param match - predicate the interceptor matches WebSocket URLs against.
   * @param handler - decides each intercepted connection.
   * @returns nothing once the interceptor is installed.
   */
  routeWebSocket(
    match: (url: URL) => boolean,
    handler: (socket: RenderSocketRoute) => Promise<void>,
  ): Promise<void>
  /** Open the context's page. */
  newPage(): Promise<RenderPage>
  /** Close the context and everything in it. */
  close(): Promise<void>
}

/** The shared headless Chromium browser process. */
export interface RenderBrowser {
  /**
   * Open one incognito context.
   * @param options - context identity and isolation applied to every request it issues.
   *   `serviceWorkers: 'block'` keeps registration off, because Playwright's request
   *   interceptor does not see requests a service worker issues.
   */
  newContext(options: Readonly<{ userAgent: string; serviceWorkers: 'block' }>): Promise<RenderContext>
  /** Close the browser process. */
  close(): Promise<void>
}

/** Opens a browser process; injected by tests, defaulted to Playwright Chromium. */
export type BrowserLauncher = () => Promise<RenderBrowser>

/** Confirms an installed browser by resolving, a missing one by rejecting. */
export type BrowserProbe = () => Promise<void>

/** Resolves the path of the browser executable a launch would run. */
export type ExecutableLocator = () => Promise<string>

/** The browser operations this provider depends on; tests substitute fakes for both. */
export interface BrowserAccess {
  /** Open the shared browser process. */
  readonly launch: BrowserLauncher
  /** Check for an installed browser without launching one. */
  readonly probe: BrowserProbe
}

/** Playwright's CLI entry inside its package directory — `bin.playwright` in its manifest. */
const PLAYWRIGHT_CLI_ENTRY = 'cli.js'

/**
 * The command named when `playwright` itself is absent. Downloading the browser alone
 * would leave the provider unable to launch it, because launching imports `playwright`,
 * so this installs the package and its browser in that order.
 */
const INSTALL_PACKAGE_AND_BROWSER = 'npm install playwright && npx playwright install chromium'

/** Double-quote one path so a directory containing spaces stays a single argument. */
const quoted = (path: string): string => `"${path}"`

/** Resolves one module specifier to a file path, or throws when it resolves to nothing. */
export type ModuleResolver = (specifier: string) => string

/** The `playwright` manifest path for one installation, or undefined when it has none. */
function resolvedPlaywrightManifest(resolve: ModuleResolver): string | undefined {
  try {
    return resolve('playwright/package.json')
  } catch {
    // Node throws MODULE_NOT_FOUND for a package that is not installed; resolution
    // reports every other outcome by returning a path.
    return undefined
  }
}

/**
 * The command that installs the browser this provider renders with. `playwright` is a
 * dependency of this package rather than of any working directory, so a bare
 * `playwright install` is not runnable where this message is read — a workspace install
 * keeps the package out of the repository root. The command therefore names the
 * resolved CLI directly and runs from any directory.
 *
 * `playwright` is a peer dependency, so a deployment can mount this plugin without it,
 * and every caller of this function is already on a failure path that a missing
 * `playwright` produces. Unresolvable is therefore an answer to give, not a throw: the
 * command names the package as well as the browser.
 * @param resolve - resolves `playwright/package.json` for the installation to name.
 * @returns a runnable install command for that installation.
 */
export function playwrightInstallCommand(resolve: ModuleResolver): string {
  const manifest = resolvedPlaywrightManifest(resolve)
  if (manifest === undefined) return INSTALL_PACKAGE_AND_BROWSER
  const cli = join(dirname(manifest), PLAYWRIGHT_CLI_ENTRY)
  return `${quoted(process.execPath)} ${quoted(cli)} install chromium`
}

/**
 * The install command for the `playwright` installation this package itself resolves.
 * @returns a runnable install command; never throws, whatever the installation is.
 */
export function chromiumInstallCommand(): string {
  return playwrightInstallCommand(specifier => createRequire(import.meta.url).resolve(specifier))
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
 * The Chromium executable `playwright` resolves for this installation. The path is
 * computed from the package's own browser registry and exists only once the browser is
 * installed.
 * @returns the absolute path of the executable a launch would run.
 */
export const chromiumExecutablePath: ExecutableLocator = async () => {
  const { chromium } = await import('playwright')
  return chromium.executablePath()
}

/**
 * Confirm an installed browser by checking that the executable a launch would run
 * exists. This costs one filesystem check, so the plugin can resolve availability while
 * applying; a launch-and-close probe would put a whole browser process on every boot.
 * @param locate - resolves the executable path to check.
 * @returns nothing once the executable exists; rejects when it does not.
 */
export async function probeExecutable(locate: ExecutableLocator): Promise<void> {
  const executable = await locate()
  if (!existsSync(executable)) {
    throw new Error(`no browser executable at ${executable}`)
  }
}

/**
 * Confirm an installed Chromium without launching it.
 * @returns nothing once Chromium's executable is present; rejects when it is not.
 */
export const probeChromium: BrowserProbe = () => probeExecutable(chromiumExecutablePath)

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
