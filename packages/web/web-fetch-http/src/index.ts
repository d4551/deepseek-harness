/**
 * Anonymous public HTTP(S) `WebFetchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-fetch-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { HttpFetchProvider } from './provider.ts'
import type { HttpFetchLimits } from './provider.ts'
import { WEB_FETCH_USER_AGENT, WEB_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-web'

export {
  LOCAL_FETCH_PROVIDER_ID,
  HttpFetchProvider,
} from './provider.ts'
export type { HttpFetchLimits, HttpFetchResolver } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-http'

/** Web registry and persisted provider configuration. */
export const inject = ['web', 'settings']

/** Plugin config: the provider's transport and size limits plus its `User-Agent` (all defaulted). */
export interface Config {
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters. */
  maxBodyChars?: number
  /** Default fetch timeout in milliseconds, within Node's timer range. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(WEB_FETCH_USER_AGENT),
})

/** Settings namespace carrying this provider's transport and response limits. */
export const WEB_FETCH_HTTP_SETTINGS_NAMESPACE = settingsNamespace('web-fetch-http')

/** A resource limit (byte/char/length/timeout cap) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number | undefined): asserts value is number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-http: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number | undefined): asserts value is number {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-http: timeoutMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** The redirect hop cap must be a non-negative integer (0 follows no redirects). */
function assertNonNegativeInteger(name: string, value: number | undefined): asserts value is number {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-http: ${name} must be a non-negative integer`)
  }
}

/** Register the local HTTP(S) fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const settings = ctx.get('settings')
  if (!settings) throw new Error('web-fetch-http requires the settings service')
  const scope = settings.register(WEB_FETCH_HTTP_SETTINGS_NAMESPACE, Config, {
    flow: WEB_SETTINGS_NAMESPACE,
    base: config,
    applies: 'restart',
  })
  const resolved = scope.get()
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  if (resolved.userAgent === undefined) throw new Error('web-fetch-http: userAgent is required')
  const limits: HttpFetchLimits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
  }
  ctx.web.registerFetchProvider(new HttpFetchProvider(limits))
}
