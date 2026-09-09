/**
 * Configurable Host plugins contributed to the shared Plugins section.
 *
 * The tab enumerates settings namespaces but never interprets one — a card
 * arrives through `settings.plugin.item` keyed by the namespace it edits, so a
 * plugin that ships a browser half owns its own card and this tab only decides
 * which keys to dispatch.
 */

import { Fragment, useState } from 'react'
import { SettingsDisclosure, SettingsFields } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import { PluginCard } from './PluginCard.tsx'

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
  const [otherOpen, setOtherOpen] = useState(false)
  const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot)
  const flows = props.useSettingsFlows(snapshot => snapshot)
  const members = new Set(flows.flatMap(flow => flow.members.map(member => member.ns)))
  const independent = namespaces.filter(ns => !members.has(ns))
  if (namespaces.length > 0) {
    return (
      <div role="list">
        {flows.map(flow => (
          <PluginCard
            key={flow.id}
            t={t}
            titleKey={flow.titleKey}
            descriptionKey={flow.descriptionKey}
            state={flow.state}
            onSave={() => props.saveFlow(flow.id)}
            onDiscard={() => { props.discardFlow(flow.id) }}
          >
            {flow.members.map(member => (
              <SettingsFields key={member.ns} title={t(member.titleKey)} description={t(member.descriptionKey)}>
                {renderSlot('settings.plugin.item', {}, { entryKey: member.ns })}
              </SettingsFields>
            ))}
          </PluginCard>
        ))}
        {independent.length > 0 && (
          <div role="listitem">
            <SettingsDisclosure
              title={t('otherGroupTitle')}
              toggleLabel={t('otherGroupTitle')}
              open={otherOpen}
              busy={false}
              status={null}
              onToggle={() => {
                const next = !otherOpen
                setOtherOpen(next)
                return next
              }}
            >
              <div role="list">
                {independent.map(ns => (
                  <Fragment key={ns}>{renderSlot('settings.plugin.item', {}, { entryKey: ns })}</Fragment>
                ))}
              </div>
            </SettingsDisclosure>
          </div>
        )}
      </div>
    )
  }
  return loaded ? <p>{t('empty')}</p> : null
}
