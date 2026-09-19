/**
 * Perplexity search over its OpenAI-compatible chat-completions endpoint. The generated answer
 * becomes `content`; sources prefer structured `search_results[]` and fall back to URL-only
 * `citations[]`. The wire format and native `fetch` client are provider-private and do not use
 * `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-perplexity/provider
 */

import { WEB_USER_AGENT, WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { PerplexityResponse, PerplexitySearchResult } from './types.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/**
 * Human text for a rejected search or parse operation.
 * @param reason - the Thrown the Promise rejected with.
 * @returns the Error message, primitive text, or object tag.
 */
function thrownMessage(reason: Thrown): string {
  if (reason instanceof Error) {
    const line = reason.stack?.split('\n', 1)[0]
    return line !== undefined && line.length > 0 ? line : reason.message
  }
  switch (typeof reason) {
    case 'string': return reason
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(reason)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (reason === null) return 'null'
      return Object.prototype.toString.call(reason)
  }
}

/** Stable id this provider registers under. */
export const PERPLEXITY_PROVIDER_ID = 'perplexity'

/** Default Perplexity endpoint; `/chat/completions` is the operation. */
export const PERPLEXITY_DEFAULT_BASE_URL = 'https://api.perplexity.ai'

/** Default search model. */
export const PERPLEXITY_DEFAULT_MODEL = 'sonar'

/** Default upper bound on generated answer tokens. */
export const PERPLEXITY_DEFAULT_MAX_TOKENS = 1024

/** Recency filter values Perplexity accepts for `search_recency_filter`. */
export type PerplexityRecency = 'day' | 'week' | 'month' | 'year'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface PerplexitySearchProviderOptions {
  /** Perplexity API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /** Search model name. */
  model: string
  /** Upper bound on generated answer tokens (`max_tokens`). */
  maxTokens: number
  /** Optional recency window sent as `search_recency_filter`; omitted = no filter. */
  searchRecency?: PerplexityRecency
}

/**
 * Map one structured Perplexity search result to a normalized source.
 *
 * @param result - one entry of the response's `search_results[]`.
 * @returns the normalized source; blank fields are omitted rather than set empty.
 */
export function mapPerplexityResult(result: PerplexitySearchResult): WebSearchSource {
  return {
    url: result.url,
    ...result.title != null && result.title.length > 0 ? { title: result.title } : {},
    ...result.snippet != null && result.snippet.length > 0 ? { snippet: result.snippet } : {},
    ...result.date != null && result.date.length > 0 ? { publishedAt: result.date } : {},
  }
}

/**
 * Map a Perplexity response envelope to a normalized search result. Prefers
 * structured `search_results[]`; falls back to URL-only `citations[]` (those
 * sources carry just a `url`) only when `search_results` is absent.
 *
 * @param response - the parsed chat-completions response body.
 * @returns the normalized result; `content` is omitted when the answer is empty.
 */
export function mapPerplexityResponse(response: PerplexityResponse): WebSearchResult {
  const content = response.choices?.[0]?.message?.content
  const sources: WebSearchSource[] = response.search_results !== undefined
    ? response.search_results.map(mapPerplexityResult)
    : (response.citations ?? []).map(url => ({ url }))
  return {
    ...content != null && content.length > 0 ? { content } : {},
    sources,
    truncated: false,
  }
}

/** The Perplexity-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class PerplexitySearchProvider implements WebSearchProvider {
  readonly id = PERPLEXITY_PROVIDER_ID

  constructor(private readonly options: PerplexitySearchProviderOptions) {}

  // Availability checks stay beside each provider's distinct config contract;
  // a shared base class would obscure which fields make this backend usable.
  available(): boolean {
    return this.options.apiKey.length > 0
      && URL.canParse(this.options.baseURL)
      && isPositiveInteger(this.options.maxTokens)
  }

  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    return fetch(`${this.options.baseURL}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'authorization': `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        'accept': 'application/json',
        'user-agent': WEB_USER_AGENT,
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: this.options.maxTokens,
        messages: [{ role: 'user', content: request.query }],
        ...this.options.searchRecency !== undefined ? { search_recency_filter: this.options.searchRecency } : {},
      }),
      ...signal !== undefined ? { signal } : {},
    }).then(
      (response) => {
        if (!response.ok) {
          const statusMessage = `Perplexity API error (HTTP ${response.status})`
          return response.json().then(
            (parsed: unknown) => {
              throw new WebError(perplexityErrorMessage(parsed, statusMessage), 'WEB_PROVIDER_ERROR')
            },
            (error: Thrown) => {
              // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
              // into a generic HTTP-error message — cancellation is not a provider
              // error (the seam's cancellation contract).
              if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
              throw new WebError(statusMessage, 'WEB_PROVIDER_ERROR')
            },
          )
        }
        return response.json().then(
          (payload: unknown) => {
            if (!isPerplexityResponse(payload)) {
              const error = new TypeError('Perplexity response body is not an object')
              throw new WebError(`Perplexity returned an unprocessable response body: ${thrownMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
            }
            return mapPerplexityResponse(payload)
          },
          (error: Thrown) => {
            if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
            throw new WebError(`Perplexity returned an unprocessable response body: ${thrownMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
          },
        )
      },
      (error: Thrown) => {
        if (isAbortError(error)) throw new WebError('Perplexity search aborted', 'WEB_ABORTED', { cause: error })
        throw new WebError(`Perplexity search request failed: ${thrownMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      },
    )
  }
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Whether a JSON value can be mapped as a Perplexity search envelope. */
function isPerplexityResponse(value: unknown): value is PerplexityResponse {
  if (typeof value !== 'object' || value === null) return false
  if ('search_results' in value && value.search_results !== undefined) {
    return Array.isArray(value.search_results)
      && value.search_results.every(item => typeof item === 'object' && item !== null)
  }
  if ('citations' in value && value.citations !== undefined) {
    return Array.isArray(value.citations)
  }
  return true
}

/** Provider error text from an error envelope, or the HTTP status line. */
function perplexityErrorMessage(parsed: unknown, statusMessage: string): string {
  if (typeof parsed !== 'object' || parsed === null) return statusMessage
  const errorField = 'error' in parsed ? parsed.error : undefined
  const messageField = 'message' in parsed && typeof parsed.message === 'string' ? parsed.message : undefined
  const detail = typeof errorField === 'string'
    ? errorField
    : typeof errorField === 'object' && errorField !== null && 'message' in errorField
      && typeof errorField.message === 'string'
      ? errorField.message
      : messageField
  return detail !== undefined && detail.length > 0 ? detail : statusMessage
}

/** True for a request limit that can be sent to Perplexity (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
