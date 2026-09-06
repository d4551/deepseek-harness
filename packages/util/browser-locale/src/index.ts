/**
 * Browser locale preference, resolved to the locales the product ships.
 *
 * Boot surfaces paint before any locale service exists and cannot ask one, so
 * each owns its own dictionary. What they must not each own is the preference
 * rule: a regional tag selects its language, and an embedder that reports no
 * tags gets English. This module is that rule, with no dependency of its own so
 * a surface waiting on the plugin tree can still use it.
 */

/** Locales the product ships copy for. */
export type BrowserLocaleId = 'en' | 'zh'

/**
 * First shipped locale a preference-ordered tag list asks for.
 * @param tags - language tags, most-preferred first.
 * @returns the matching locale id, defaulting to English.
 */
function matchShippedLocale(tags: readonly string[]): BrowserLocaleId {
  for (const tag of tags) {
    // A regional tag still selects its language: `zh-CN`, `zh-Hant`, and `zh`
    // all take the Chinese dictionary.
    if (tag.toLowerCase().split('-')[0] === 'zh') return 'zh'
  }
  return 'en'
}

/**
 * Resolve the locale a browser asks for.
 *
 * `navigator` exists on the host global in non-browser runs and reports the
 * machine's language, which must not decide a page's locale; only a real
 * `window` admits it, and a run without one is English without consulting any
 * tag list. `languages` is ordered by preference and absent on some embedders,
 * so `language` is the documented fallback for the whole list.
 * @param tags - override for the browser's tags; omitted, the browser is read.
 * @returns the matching locale id, defaulting to English.
 */
export function resolveBrowserLocale(tags?: readonly string[]): BrowserLocaleId {
  if (tags !== undefined) return matchShippedLocale(tags)
  if (typeof window === 'undefined') return 'en'
  const browser = navigator as { readonly languages?: readonly string[]; readonly language: string }
  if (browser.languages === undefined) return matchShippedLocale([browser.language])
  return matchShippedLocale(browser.languages)
}
