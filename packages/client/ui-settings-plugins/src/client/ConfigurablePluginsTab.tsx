/**
 * Configurable Host plugins contributed to the shared Plugins section.
 *
 * The tab enumerates settings namespaces but never interprets one — a card
 * arrives through `settings.plugin.item` keyed by the namespace it edits, so a
 * plugin that ships a browser half owns its own card and this tab only decides
 * which keys to dispatch.
 */

import { Fragment, useState } from 'react'
import { DisclosureRow, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import { settingsGroups } from './settings-groups.ts'

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
  const [openFlows, setOpenFlows] = useState<ReadonlySet<string>>(() => new Set())
  if (namespaces.length > 0) {
    return (
      <div>
        {settingsGroups(namespaces).map((group) => {
          const toggleFlow = () => {
            setOpenFlows((previous) => {
              const next = new Set(previous)
              if (next.has(group.title)) next.delete(group.title)
              else next.add(group.title)
              return next
            })
          }
          return (
            <DisclosureRow
              key={group.title}
              title={t(group.title)}
              icon={<IconChevronDownOutline14 />}
              open={openFlows.has(group.title)}
              expandable
              expandOnRowClick
              keepMounted
              onToggle={toggleFlow}
            >
              <div role="list">
                {group.namespaces.map(ns => (
                  <Fragment key={ns}>{renderSlot('settings.plugin.item', {}, { entryKey: ns })}</Fragment>
                ))}
              </div>
            </DisclosureRow>
          )
        })}
      </div>
    )
  }
  return loaded ? <p>{t('empty')}</p> : null
}
