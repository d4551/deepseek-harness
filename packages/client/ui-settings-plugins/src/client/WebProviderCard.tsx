/**
 * One web backend's card, rendered from its catalogue entry: the fields its
 * settings section declares, and — for the backend that renders pages — whether
 * this deployment found a browser to render with.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import css from './fields.module.css'
import type { WebProviderCardFace } from './web-provider-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for a web backend's card. */
export type WebProviderCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebProviderCardFace>

/**
 * Render one web backend's card.
 * @param props - locale copy, the catalogue entry, the card snapshot, and its form actions.
 * @returns the card.
 */
export function WebProviderCard(props: WebProviderCardProps) {
  const { spec, t } = props
  const state = props.useWebProviderCard(snapshot => snapshot)
  const disabled = !state.writable
  return (
    <PluginCard
      t={t}
      titleKey={spec.titleKey}
      descriptionKey={spec.descriptionKey}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {spec.browserField === undefined || state.browserConfirmed
        ? null
        : <p className={css.notice} role="alert">{t('webFetchBrowserMissing')}</p>}
      {spec.fields.map((field) => {
        const control = state.fields[field.field] ?? { text: '', overridden: false, invalid: false }
        const id = `plugin-config-${spec.ns}-${field.field}`
        if (field.kind === 'secret') {
          return (
            <SecretField
              key={field.field}
              id={id}
              label={t(field.labelKey)}
              hint={t(field.hintKey)}
              disabled={disabled}
              text={control.text}
              configured={state.secretConfigured}
              stateLabel={state.secretConfigured ? t('webApiKeySet') : t('webApiKeyUnset')}
              onEdit={(text) => { props.edit(field.field, text) }}
            />
          )
        }
        return (
          <ValueField
            key={field.field}
            id={id}
            label={t(field.labelKey)}
            hint={t(field.hintKey)}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalidNumber')}
            numeric={field.kind === 'number'}
            disabled={disabled}
            {...control}
            onEdit={(text) => { props.edit(field.field, text) }}
            onReset={() => { props.resetField(field.field) }}
          />
        )
      })}
    </PluginCard>
  )
}
