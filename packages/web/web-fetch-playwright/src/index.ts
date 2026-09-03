/**
 * Opt-in Playwright Chromium `WebFetchProvider` plugin. It contributes a rendered-page
 * fetcher to the `ctx.web` registry without owning the service.
 * @module @deepseek-ai/dsh-web-fetch-playwright
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import { chromiumAccess, chromiumInstallCommand, PlaywrightFetchProvider } from './provider.ts'
import type { BrowserAccess, PlaywrightFetchLimits } from './provider.ts'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http/policy'

export {
  chromiumAccess,
  launchChromium,
  probeChromium,
  PLAYWRIGHT_FETCH_PROVIDER_ID,
  PlaywrightFetchProvider,
} from './provider.ts'
export type {
  BoundedDom,
  BrowserAccess,
  BrowserLauncher,
  BrowserProbe,
  BrowserSelection,
  PlaywrightFetchLimits,
  RenderBrowser,
  RenderContext,
  RenderPage,
  RenderRequest,
  RenderRoute,
  RenderSocketRoute,
  RenderedNavigation,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-playwright'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config: the provider's render, identity, concurrency, and time limits, plus the browser to run. */
export interface Config {
  /** Maximum rendered body length in characters. */
  maxBodyChars?: number
  /** Per-fetch budget in milliseconds, within Node's timer range. */
  timeoutMs?: number
  /** Maximum renders holding a browser context at the same time. */
  maxConcurrentRenders?: number
  /** `User-Agent` every rendered request carries. */
  userAgent?: string
  /**
   * Browser executable to render with; omitted uses the installation
   * `playwright` resolves for itself. In the settings section's composition
   * layer this field is present exactly when the mount-time probe confirmed a
   * browser there, so a configuration surface reads its absence as "no browser
   * installation was found".
   */
  executablePath?: string
}

export const Config: z<Config> = z.object({
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxConcurrentRenders: z.number().default(2),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  executablePath: z.string(),
})

/** Settings namespace carrying this provider's render limits and browser selection. */
export const WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE = settingsNamespace('web-fetch-playwright')

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A render limit (char cap or time budget) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-playwright: ${name} must be a positive finite number`)
  }
}

/** A render slot is a whole browser context, so the cap must be a positive integer. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`web-fetch-playwright: ${name} must be a positive integer`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-playwright: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Register the Playwright-rendering fetch provider with `ctx.web` and close its
 * browser on dispose. The browser installation is probed once here — one filesystem
 * check, not a launch — so the seam reads availability without the provider probing on
 * every selection and without a browser process on every boot.
 * @param ctx - plugin context carrying the web seam.
 * @param config - validated plugin config; schemastery has applied every default.
 * @param access - browser launch and installation probe; tests inject fakes here.
 * @returns nothing once the provider is registered.
 */
export async function apply(ctx: Context, config: Config, access: BrowserAccess = chromiumAccess): Promise<void> {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertPositiveInteger('maxConcurrentRenders', resolved.maxConcurrentRenders)
  const limits: PlaywrightFetchLimits = {
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxConcurrentRenders: resolved.maxConcurrentRenders,
    userAgent: resolved.userAgent,
    ...config.executablePath === undefined ? {} : { executablePath: config.executablePath },
  }
  const provider = new PlaywrightFetchProvider(limits, access)
  // The disposer is armed before the probe so a provider that launches a browser
  // later is always closed with the fiber. Disposal settles every close itself, so
  // there is nothing here to report.
  ctx.effect(function* () {
    yield () => provider.dispose()
  }, 'web-fetch-playwright: shared browser')
  if (!await provider.resolveAvailability()) {
    ctx.logger.warn('web-fetch-playwright: no browser installation found; install one with: %s', chromiumInstallCommand())
  }
  // The section is registered after the probe so its composition layer carries
  // the confirmed executable: the render slots bind a capacity gate at
  // construction, so a stored change waits for the next boot.
  installSettingsSection(ctx, WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE, Config, confirmedEntry(config, provider), {
    applies: 'restart',
    setSource: () => {},
    onChange: () => {},
  })
  ctx.web.registerFetchProvider(provider)
}

/**
 * The composition layer this plugin publishes: its entry config, with
 * `executablePath` replaced by the browser the probe confirmed and removed when
 * it confirmed none. A configured path that does not exist must not read as a
 * working installation.
 * @param config - the plugin's composition entry.
 * @param provider - the provider whose probe already ran.
 * @returns the entry to publish as the settings composition layer.
 */
function confirmedEntry(config: Config, provider: PlaywrightFetchProvider): Config {
  const { executablePath: _configured, ...rest } = config
  const confirmed = provider.browserExecutable()
  return confirmed === undefined ? rest : { ...rest, executablePath: confirmed }
}
