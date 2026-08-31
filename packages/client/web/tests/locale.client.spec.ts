// @vitest-environment jsdom
/**
 * The boot shell paints before the plugin-owned locale service exists, so its
 * dictionary is its own. These pin the resolution the browser drives and the
 * key-set parity the two languages must keep.
 */
import { describe, expect, it } from 'vitest'
import { bootCopy, en, resolveBootLocale, zh } from '../src/locale.ts'

describe('boot locale', () => {
  it('keeps the same key set in both languages', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('translates every key rather than echoing the English', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zh[key]).not.toBe(en[key])
      expect(zh[key].trim()).not.toBe('')
    }
  })

  it.each([
    [['zh-CN'], 'zh'],
    [['zh'], 'zh'],
    [['zh-Hant', 'en-US'], 'zh'],
    [['en-GB'], 'en'],
    [['fr-FR', 'zh-CN'], 'zh'],
    [['fr-FR'], 'en'],
    [[], 'en'],
  ])('resolves %j to %s', (tags, expected) => {
    expect(resolveBootLocale(tags)).toBe(expected)
  })

  it('hands back the dictionary for the resolved locale', () => {
    expect(bootCopy('zh')).toBe(zh)
    expect(bootCopy('en')).toBe(en)
  })
})
