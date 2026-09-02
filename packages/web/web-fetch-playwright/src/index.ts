/**
 * Opt-in Playwright Chromium `WebFetchProvider` plugin. It contributes a rendered-page
 * fetcher to the `ctx.web` registry without owning the service.
 * @module @deepseek-ai/dsh-web-fetch-playwright
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { launchChromium, PlaywrightFetchProvider } from './provider.ts'
import type { BrowserLauncher, PlaywrightFetchLimits } from './provider.ts'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

export {
  PLAYWRIGHT_FETCH_PROVIDER_ID,
  PlaywrightFetchProvider,
} from './provider.ts'
export type {
  BrowserLauncher,
  PlaywrightFetchLimits,
  RenderBrowser,
  RenderContext,
  RenderPage,
  RenderedNavigation,
} from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-playwright'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config: the provider's render and time limits (all defaulted). */
export interface Config {
  /** Maximum rendered body length in characters. */
  maxBodyChars?: number
  /** Per-fetch budget in milliseconds, within Node's timer range. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A render limit (char cap or time budget) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-playwright: ${name} must be a positive finite number`)
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
 * browser on dispose.
 * @param ctx - plugin context carrying the web seam.
 * @param config - validated plugin config; schemastery has applied every default.
 * @param launch - browser factory the provider uses; tests inject a fake here.
 */
export function apply(ctx: Context, config: Config, launch: BrowserLauncher = launchChromium): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  const limits: PlaywrightFetchLimits = {
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
  }
  const provider = new PlaywrightFetchProvider(limits, launch)
  ctx.web.registerFetchProvider(provider)
  ctx.effect(function* () {
    const warnCloseFailure = (closeFailure: Error): void => {
      ctx.logger.warn('web-fetch-playwright: browser close failed: %s', String(closeFailure))
    }
    yield () => provider.dispose().then(undefined, warnCloseFailure)
  }, 'web-fetch-playwright: shared browser')
}
