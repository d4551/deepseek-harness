import { describe, expect, it } from 'vitest'
import { resolveBrowserLocale } from '../src/index.ts'

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
    expect(resolveBrowserLocale()).toBe('en')
  })
})
