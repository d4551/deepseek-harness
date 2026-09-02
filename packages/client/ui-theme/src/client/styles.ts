import type { Context } from '@deepseek-ai/cordis'
import base from '../styles/base.css?inline'
import designPlatform from '../styles/design-platform.css?inline'
import scrollbar from '../styles/scrollbar.css?inline'
import gradientShadowText from '../styles/gradient-shadow-text.css?inline'
import shiki from '../styles/shiki.css?inline'
import zScale from '../styles/z-scale.css?inline'
import visuallyHidden from '../styles/visually-hidden.css?inline'
import settingsCell from '../styles/settings-cell.css?inline'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'

const STYLES = [
  ['base.css', base],
  ['design-platform.css', designPlatform],
  ['z-scale.css', zScale],
  ['visually-hidden.css', visuallyHidden],
  ['settings-cell.css', settingsCell],
  ['scrollbar.css', scrollbar],
  ['gradient-shadow-text.css', gradientShadowText],
  ['shiki.css', shiki],
] as const

/**
 * Mount the global theme sheets for exactly the owning plugin lifetime.
 * @param ctx - Owning plugin context.
 */
export function installThemeStyles(ctx: Context): void {
  if (typeof document === 'undefined') return
  for (const [name, css] of STYLES) {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }, `ui-theme: ${name} stylesheet`)
  }
}
