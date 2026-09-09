/**
 * Configurable Host plugins contributed to the shared Plugins section.
 *
 * The tab enumerates settings namespaces but never interprets one — a card
 * arrives through `settings.plugin.item` keyed by the namespace it edits, so a
 * plugin that ships a browser half owns its own card and this tab only decides
 * which keys to dispatch.
 */

import { Fragment } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import { settingsGroups } from './settings-groups.ts'
import css from './PluginsSettingsSection.module.css'

/** Props the renderer binds for the configurable tab. */
export type ConfigurablePluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugin.item'>
  & InjectFace<ConfigurablePluginsTabFace>

/**
 * Render cards registered by plugins that expose editable settings.
 * @param props - locale copy, slot rendering, and the namespaces to dispatch.
 * @returns the card list, or the empty line once the Host has answered.
 */
export function ConfigurablePluginsTab(props: ConfigurablePluginsTabProps) {
  const { t, renderSlot } = props
  const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot)
  if (namespaces.length > 0) {
    return (
      <div className={css.section}>
        {settingsGroups(namespaces).map(group => (
          <section key={group.title} className={css.section} aria-label={t(group.title)}>
            <h3 className={css.heading}>{t(group.title)}</h3>
            <p className={css.intro}>{t(group.description)}</p>
            <div className={css.cards} role="list">
              {group.namespaces.map(ns => (
                <Fragment key={ns}>{renderSlot('settings.plugin.item', {}, { entryKey: ns })}</Fragment>
              ))}
            </div>
          </section>
        ))}
      </div>
    )
  }
  return loaded ? <p className={css.empty}>{t('empty')}</p> : null
}
