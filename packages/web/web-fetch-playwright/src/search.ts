/** Browser search URL construction and extraction of Bing's organic result cards. */
import { DomUtils, parseDocument } from 'htmlparser2'
import { selectAll, selectOne } from 'css-select'
import type { AnyNode, Element } from 'domhandler'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchResult, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { validateFetchUrl } from '@deepseek-ai/dsh-web-fetch-http/policy'

/** Public browser search entry point; credentials and API subscriptions are unnecessary. */
export const BROWSER_SEARCH_ENDPOINT = 'https://www.bing.com/search'

/**
 * Construct one search navigation from the caller's literal query.
 * @param request - search request containing a non-empty query.
 * @returns the public search URL with the query encoded as a URL parameter.
 */
export function browserSearchUrl(request: WebSearchRequest): string {
  if (request.query.trim().length === 0) throw new WebError('Search query is empty', 'WEB_INVALID_QUERY')
  const url = new URL(BROWSER_SEARCH_ENDPOINT)
  url.searchParams.set('q', request.query)
  return url.href
}

/** Resolve a result's direct citation without contacting the tracking redirect. */
function sourceUrl(href: string, base: string): string {
  const url = URL.parse(href, base)
  if (url === null) throw new WebError('Browser search returned an invalid result URL', 'WEB_PROVIDER_ERROR')
  if (url.origin === new URL(BROWSER_SEARCH_ENDPOINT).origin && url.pathname === '/ck/a') {
    const encoded = url.searchParams.get('u')
    if (encoded === null || !encoded.startsWith('a1')) {
      throw new WebError('Browser search returned an unrecognized result redirect', 'WEB_PROVIDER_ERROR')
    }
    return validateFetchUrl(Buffer.from(encoded.slice(2), 'base64url').toString('utf8')).href
  }
  return validateFetchUrl(url.href).href
}

/**
 * Extract source-backed results; a challenge or changed page contract is an error.
 * @param page - bounded rendered search page returned by the browser provider.
 * @param request - search request carrying the optional result-count limit.
 * @returns deduplicated organic sources and whether the page or result list was truncated.
 */
export function browserSearchResults(page: WebFetchResult, request: WebSearchRequest): WebSearchResult {
  if (page.statusCode !== 200 || page.body.kind !== 'html') {
    throw new WebError(`Browser search returned HTTP ${page.statusCode} without a search page`, 'WEB_SEARCH_UNAVAILABLE')
  }
  const document = parseDocument(page.body.content)
  if (selectOne<AnyNode, Element>('#b_captcha, #captcha, form[action*="challenge"]', document) !== null) {
    throw new WebError('Browser search requires human verification', 'WEB_SEARCH_CHALLENGE')
  }
  const rows = selectAll<AnyNode, Element>('#b_results > li.b_algo', document)
  if (rows.length === 0 && selectOne<AnyNode, Element>('#b_results .b_no', document) === null) {
    throw new WebError('Browser search returned an unrecognized results page', 'WEB_SEARCH_UNAVAILABLE')
  }
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const anchor = selectOne<AnyNode, Element>('h2 a[href]', row)
    const href = anchor?.attribs.href
    const title = anchor === null ? undefined : DomUtils.textContent(anchor).trim()
    if (href === undefined || title === undefined || title.length === 0) {
      throw new WebError('Browser search returned an incomplete result', 'WEB_PROVIDER_ERROR')
    }
    const url = sourceUrl(href, page.url)
    if (seen.has(url)) continue
    seen.add(url)
    const caption = selectOne<AnyNode, Element>('.b_caption p', row)
    const snippet = caption === null ? undefined : DomUtils.textContent(caption).trim()
    sources.push({ url, title, ...snippet === undefined || snippet.length === 0 ? {} : { snippet } })
  }
  const limit = request.maxResults ?? sources.length
  return { sources: sources.slice(0, limit), truncated: page.truncated || sources.length > limit }
}
