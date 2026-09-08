import { describe, expect, it } from 'vitest'
import type { WebFetchResult } from '@deepseek-ai/dsh-web'
import { browserSearchResults, browserSearchUrl } from '../src/search.ts'

function resultPage(content: string, truncated = false): WebFetchResult {
  return { url: browserSearchUrl({ query: 'compiler' }), statusCode: 200, body: { kind: 'html', content }, truncated }
}

describe('browser search extraction', () => {
  it('encodes a literal query without allowing URL parameters to change it', () => {
    const url = new URL(browserSearchUrl({ query: 'symbols & aliases #日本語' }))
    expect(url.origin).toBe('https://www.bing.com')
    expect(url.searchParams.get('q')).toBe('symbols & aliases #日本語')
    expect([...url.searchParams.keys()]).toEqual(['q'])
    expect(() => browserSearchUrl({ query: ' \n ' })).toThrow(expect.objectContaining({ code: 'WEB_INVALID_QUERY' }))
  })

  it('extracts organic titles and snippets, resolves citations, deduplicates and bounds results', () => {
    const encoded = Buffer.from('https://www.typescriptlang.org/docs/').toString('base64url')
    const page = resultPage(`<ol id="b_results">
      <li class="b_ad"><h2><a href="https://advertiser.example/">Advertisement</a></h2></li>
      <li class="b_algo"><h2><a href="/ck/a?u=a1${encoded}"> TypeScript &amp; types </a></h2><div class="b_caption"><p> Imported <b>aliases</b> </p></div></li>
      <li class="b_algo"><h2><a href="https://www.typescriptlang.org/docs/">Repeated source</a></h2></li>
      <li class="b_algo"><h2><a href="https://github.com/microsoft/TypeScript">Compiler source</a></h2></li>
    </ol>`)
    expect(browserSearchResults(page, { query: 'compiler' })).toEqual({
      sources: [
        { url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript & types', snippet: 'Imported aliases' },
        { url: 'https://github.com/microsoft/TypeScript', title: 'Compiler source' },
      ],
      truncated: false,
    })
    expect(browserSearchResults(page, { query: 'compiler', maxResults: 1 })).toEqual({
      sources: [{ url: 'https://www.typescriptlang.org/docs/', title: 'TypeScript & types', snippet: 'Imported aliases' }],
      truncated: true,
    })
  })

  it('reports explicit empty results and preserves the rendered document limit', () => {
    const empty = '<ol id="b_results"><li class="b_no">No results</li></ol>'
    expect(browserSearchResults(resultPage(empty), { query: 'compiler' })).toEqual({ sources: [], truncated: false })
    expect(browserSearchResults(resultPage(empty, true), { query: 'compiler' })).toEqual({ sources: [], truncated: true })
  })

  it('refuses challenges, errors, changed markup and malformed sources', () => {
    expect(() => browserSearchResults(resultPage('<div id="b_captcha"></div>'), { query: 'compiler' }))
      .toThrow(expect.objectContaining({ code: 'WEB_SEARCH_CHALLENGE' }))
    expect(() => browserSearchResults(resultPage('<html>Access denied</html>'), { query: 'compiler' }))
      .toThrow(expect.objectContaining({ code: 'WEB_SEARCH_UNAVAILABLE' }))
    expect(() => browserSearchResults({ ...resultPage(''), statusCode: 429 }, { query: 'compiler' }))
      .toThrow(expect.objectContaining({ code: 'WEB_SEARCH_UNAVAILABLE' }))
    expect(() => browserSearchResults({ ...resultPage(''), body: { kind: 'text', content: 'Blocked' } }, { query: 'compiler' }))
      .toThrow(expect.objectContaining({ code: 'WEB_SEARCH_UNAVAILABLE' }))
    for (const content of [
      '<h2>Missing link</h2>',
      '<h2><a href="https://example.com/"></a></h2>',
      '<h2><a href="/ck/a?u=bad">Bad redirect</a></h2>',
      '<h2><a href="javascript:alert(1)">Invalid scheme</a></h2>',
      '<h2><a href="https://user:secret@example.com/">Credentials</a></h2>',
    ]) {
      expect(() => browserSearchResults(resultPage(`<ol id="b_results"><li class="b_algo">${content}</li></ol>`), { query: 'compiler' })).toThrow()
    }
  })
})
