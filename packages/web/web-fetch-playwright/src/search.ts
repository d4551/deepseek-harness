/** Browser search URL construction and extraction of Bing's organic result cards. */
import { parseHTML } from 'linkedom'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchResult, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import { validateFetchUrl } from '@deepseek-ai/dsh-web-fetch-http/policy'

/** Public browser search entry point; credentials and API subscriptions are unnecessary. */
export const BROWSER_SEARCH_ENDPOINT = 'https://www.bing.com/search'

/** Construct one search navigation from the caller's literal query. */
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

/** Extract source-backed results; a challenge or changed page contract is an error. */
export function browserSearchResults(page: WebFetchResult, request: WebSearchRequest): WebSearchResult {
  if (page.statusCode !== 200 || page.body.kind !== 'html') {
    throw new WebError(`Browser search returned HTTP ${page.statusCode} without a search page`, 'WEB_SEARCH_UNAVAILABLE')
  }
  const { document } = parseHTML(page.body.content)
  if (document.querySelector('#b_captcha, #captcha, form[action*="challenge"]') !== null) {
    throw new WebError('Browser search requires human verification', 'WEB_SEARCH_CHALLENGE')
  }
  const rows = document.querySelectorAll('#b_results > li.b_algo')
  if (rows.length === 0 && document.querySelector('#b_results .b_no') === null) {
    throw new WebError('Browser search returned an unrecognized results page', 'WEB_SEARCH_UNAVAILABLE')
  }
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const anchor = row.querySelector('h2 a[href]')
    const href = anchor?.getAttribute('href')
    const title = anchor?.textContent.trim()
    if (href === undefined || href === null || title === undefined || title.length === 0) {
      throw new WebError('Browser search returned an incomplete result', 'WEB_PROVIDER_ERROR')
    }
    const url = sourceUrl(href, page.url)
    if (seen.has(url)) continue
    seen.add(url)
    const snippet = row.querySelector('.b_caption p')?.textContent.trim()
    sources.push({ url, title, ...snippet === undefined || snippet.length === 0 ? {} : { snippet } })
  }
  const limit = request.maxResults ?? sources.length
  return { sources: sources.slice(0, limit), truncated: page.truncated || sources.length > limit }
}
