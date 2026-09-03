/**
 * The web-access card: which backend serves `web_search`, which serves
 * `web_fetch`, and what this deployment did not mount.
 *
 * Fetch is the choice with consequences a user cannot see from the tool: the
 * rendering backend runs the page's own JavaScript in a browser, while the
 * HTTP backend retrieves bytes and runs nothing. Both options therefore say
 * what they do, and a selected rendering backend with no browser behind it
 * says that too.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ChoiceField, type ChoiceOption } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import css from './fields.module.css'
import type { WebAccessCardFace, WebCapabilityState, WebProviderChoice } from './web-access-card-controller.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the web-access card. */
export type WebAccessCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebAccessCardFace>

/**
 * Project one capability's backends into radio options.
 * @param state - the capability's staged field and its backends.
 * @param t - locale reader for this section's copy.
 * @returns the options the radio group renders.
 */
function optionsOf(
  state: WebCapabilityState,
  t: (key: PluginsSettingsLocaleKey) => string,
): readonly ChoiceOption[] {
  return state.choices.map((choice: WebProviderChoice): ChoiceOption => ({
    value: choice.id,
    label: t(choice.titleKey),
    description: t(choice.descriptionKey),
    selected: choice.selected,
    pickable: choice.mounted,
    ...choice.mounted ? {} : { unavailableLabel: `${t('webProviderNotMounted')} ${choice.moduleName}` },
  }))
}

/**
 * Render the web-access card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebAccessCard(props: WebAccessCardProps) {
  const { t } = props
  const state = props.useWebAccessCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey="webAccessTitle"
      descriptionKey="webAccessDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ChoiceField
        id="plugin-config-web-search-provider"
        name="plugin-config-web-search-provider"
        label={t('webSearchProvider')}
        hint={state.search.automatic ? t('webProviderAutomatic') : t('webSearchProviderHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        overridden={state.search.field.overridden}
        disabled={disabled}
        options={optionsOf(state.search, t)}
        onPick={(value) => { props.edit('searchProvider', value) }}
        onReset={() => { props.resetField('searchProvider') }}
      />
      <ChoiceField
        id="plugin-config-web-fetch-provider"
        name="plugin-config-web-fetch-provider"
        label={t('webFetchProvider')}
        hint={state.fetch.automatic ? t('webProviderAutomatic') : t('webFetchProviderHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        overridden={state.fetch.field.overridden}
        disabled={disabled}
        options={optionsOf(state.fetch, t)}
        onPick={(value) => { props.edit('fetchProvider', value) }}
        onReset={() => { props.resetField('fetchProvider') }}
      />
      {state.browserMissing
        ? <p className={css.notice} role="alert">{t('webFetchBrowserMissing')}</p>
        : null}
    </PluginCard>
  )
}
