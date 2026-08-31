/**
 * Copy for the pre-boot preview-source chooser, in the two locales the product
 * ships.
 *
 * The chooser paints before the Worker and the plugin tree exist, so the
 * locale service that owns the rest of the Client's copy cannot be asked. This
 * prototype is also bundled on its own, with no dependency on the Client tree,
 * so it resolves the browser's preference itself rather than importing a
 * resolver across a package edge that this bundle deliberately does not have.
 * @module
 */
import { resolveBrowserLocale } from '@deepseek-ai/dsh-browser-locale'
import type { BrowserLocaleId } from '@deepseek-ai/dsh-browser-locale'

/** Locales the chooser paints. */
export type ChooserLocaleId = BrowserLocaleId

/** Copy keys the chooser renders. */
export interface ChooserCopy {
  /** Dialog heading. */
  readonly heading: string
  /** Sentence under the heading explaining when the choice takes effect. */
  readonly intro: string
  /** Legend over the list of sources. */
  readonly legend: string
  /** Submit button. */
  readonly submit: string
  /** Name of the source that mounts nothing. */
  readonly emptyLabel: string
  /** What the empty source is for. */
  readonly emptyDescription: string
  /** Name of the browser-directory source. */
  readonly webfsLabel: string
  /** Why the browser-directory source is not selectable yet. */
  readonly webfsDescription: string
}

/** English chooser copy. */
export const en: ChooserCopy = {
  heading: 'Choose Preview data',
  intro: 'Data mounts before the Worker and application start. Refresh to choose again.',
  legend: 'Filesystem source',
  submit: 'Start Preview',
  emptyLabel: 'Empty environment',
  emptyDescription: 'Load only the base runtime to verify first launch and workspace creation.',
  webfsLabel: 'WebFS directory',
  webfsDescription: 'Requires directory access and will be available after the WebFS provider lands.',
}

/** Simplified Chinese chooser copy. */
export const zh: ChooserCopy = {
  heading: '选择预览数据',
  intro: '数据在 Worker 和应用启动前挂载。刷新页面可重新选择。',
  legend: '文件系统来源',
  submit: '启动预览',
  emptyLabel: '空环境',
  emptyDescription: '仅加载基础运行时，用于验证首次启动和工作区创建。',
  webfsLabel: 'WebFS 目录',
  webfsDescription: '需要目录访问权限，将在 WebFS 提供方落地后可用。',
}

const DICTIONARIES: Readonly<Record<ChooserLocaleId, ChooserCopy>> = { en, zh }

/**
 * Pick the chooser locale from the browser's ordered language preferences.
 * @param tags - override for the browser's tags; omitted, the browser is read.
 * @returns the matching locale id, defaulting to English.
 */
export function resolveChooserLocale(tags?: readonly string[]): ChooserLocaleId {
  return resolveBrowserLocale(tags)
}

/**
 * Chooser copy for one locale.
 * @param locale - resolved locale; omitted, the browser decides.
 * @returns the dictionary for that locale.
 */
export function chooserCopy(locale: ChooserLocaleId = resolveChooserLocale()): ChooserCopy {
  return DICTIONARIES[locale]
}
