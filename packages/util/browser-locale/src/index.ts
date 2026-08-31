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
 * Resolve the locale a browser asks for.
 *
 * `navigator` exists on the host global in non-browser runs and reports the
 * machine's language, which must not decide a page's locale; only a real
 * `window` admits it. `languages` is ordered by preference and absent on some
 * embedders, so `language` is the documented fallback.
 * @param tags - override for the browser's tags; omitted, the browser is read.
 * @returns the matching locale id, defaulting to English.
 */
export function resolveBrowserLocale(tags?: readonly string[]): BrowserLocaleId {
  const requested = tags ?? (typeof window === 'undefined'
    ? []
    : [...(navigator as { readonly languages?: readonly string[] }).languages ?? [], navigator.language])
  for (const tag of requested) {
    // A regional tag still selects its language: `zh-CN`, `zh-Hant`, and `zh`
    // all take the Chinese dictionary.
    if (tag.toLowerCase().split('-')[0] === 'zh') return 'zh'
  }
  return 'en'
}
