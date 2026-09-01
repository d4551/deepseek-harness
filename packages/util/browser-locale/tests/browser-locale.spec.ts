import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBrowserLocale } from '../src/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveBrowserLocale', () => {
  it('takes the Chinese dictionary for any Chinese tag, regional or not', () => {
    expect(resolveBrowserLocale(['zh'])).toBe('zh')
    expect(resolveBrowserLocale(['zh-CN'])).toBe('zh')
    expect(resolveBrowserLocale(['zh-Hant'])).toBe('zh')
    expect(resolveBrowserLocale(['ZH-cn'])).toBe('zh')
  })

  it('takes Chinese from anywhere in the tag list, not only the first tag', () => {
    expect(resolveBrowserLocale(['fr', 'zh-CN', 'en'])).toBe('zh')
    expect(resolveBrowserLocale(['en-GB', 'zh'])).toBe('zh')
  })

  it('defaults to English for no tags and for unshipped languages', () => {
    expect(resolveBrowserLocale([])).toBe('en')
    expect(resolveBrowserLocale(['fr-FR', 'de'])).toBe('en')
  })

  it('reads no host global when the run has no window', () => {
    vi.stubGlobal('navigator', { language: 'zh' })
    expect(resolveBrowserLocale()).toBe('en')
  })

  it('reads the browser tag list, preference-ordered with language as the fallback', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['en-US', 'zh-Hans'] })
    expect(resolveBrowserLocale()).toBe('zh')

    vi.stubGlobal('navigator', { language: 'fr' })
    expect(resolveBrowserLocale()).toBe('en')
  })

  it('resolves from languages alone when the embedder reports no language fallback', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { languages: ['zh-Hans'] })
    expect(resolveBrowserLocale()).toBe('zh')
  })

  it('falls back to language when the embedder reports no languages list', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { language: 'zh-TW' })
    expect(resolveBrowserLocale()).toBe('zh')
  })
})
