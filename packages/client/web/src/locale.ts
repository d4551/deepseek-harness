/**
 * Boot-shell copy, in the two locales the product ships.
 *
 * The boot page paints before any plugin loads, so the locale service that
 * owns the rest of the Client's copy does not exist yet and cannot be asked.
 * This dictionary is the boot shell's own locale owner: same key set per
 * language, resolved from the browser's own preference, with no dependency on
 * the plugin tree it is waiting for. The preference rule itself is shared, in a
 * package that likewise depends on nothing.
 */
import { resolveBrowserLocale } from '@deepseek-ai/dsh-browser-locale'
import type { BrowserLocaleId } from '@deepseek-ai/dsh-browser-locale'

/** Locales the boot shell paints. */
export type BootLocaleId = BrowserLocaleId

/** Copy keys the boot shell renders. */
export interface BootCopy {
  /** Progress line under the wordmark while the plugin tree loads. */
  readonly loading: string
  /** Heading shown when one or more plugins failed to load. */
  readonly failed: string
}

/** English boot copy. */
export const en: BootCopy = {
  loading: 'Loading plugins…',
  failed: 'Failed to load plugins',
}

/** Simplified Chinese boot copy. */
export const zh: BootCopy = {
  loading: '正在加载插件…',
  failed: '插件加载失败',
}

const DICTIONARIES: Readonly<Record<BootLocaleId, BootCopy>> = { en, zh }

/**
 * Pick the boot locale from the browser's ordered language preferences.
 * @param tags - override for the browser's tags; omitted, the browser is read.
 * @returns the matching locale id, defaulting to English.
 */
export function resolveBootLocale(tags?: readonly string[]): BootLocaleId {
  return resolveBrowserLocale(tags)
}

/**
 * Boot copy for one locale.
 * @param locale - resolved boot locale; omitted, the browser decides.
 * @returns the dictionary for that locale.
 */
export function bootCopy(locale: BootLocaleId = resolveBootLocale()): BootCopy {
  return DICTIONARIES[locale]
}
