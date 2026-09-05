/** The adversarial-review card: whether a model reviewer decides approvals, on which route, and how it fails. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ChoiceField, MultilineField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { ApprovalAdversaryCardFace } from './approval-adversary-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the adversarial-review card. */
export type ApprovalAdversaryCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<ApprovalAdversaryCardFace>

/**
 * Render the adversarial-review card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function ApprovalAdversaryCard(props: ApprovalAdversaryCardProps) {
  const { t } = props
  const state = props.useApprovalAdversaryCard(snapshot => snapshot)
  const shared = {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    disabled: !state.writable,
  }
  return (
    <PluginCard
      t={t}
      titleKey="approvalAdversaryTitle"
      descriptionKey="approvalAdversaryDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ChoiceField
        id="plugin-config-approval-adversary-enabled"
        name="plugin-config-approval-adversary-enabled"
        label={t('approvalAdversaryEnabled')}
        hint={t('approvalAdversaryEnabledHint')}
        {...shared}
        overridden={state.enabled.overridden}
        options={[
          {
            value: 'true',
            label: t('approvalAdversaryEnabledOn'),
            description: t('approvalAdversaryEnabledOnHint'),
            selected: state.enabled.text === 'true',
            pickable: true,
          },
          {
            value: 'false',
            label: t('approvalAdversaryEnabledOff'),
            description: t('approvalAdversaryEnabledOffHint'),
            selected: state.enabled.text === 'false',
            pickable: true,
          },
        ]}
        onPick={(value) => { props.edit('enabled', value) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <ValueField
        id="plugin-config-approval-adversary-provider"
        label={t('approvalAdversaryProvider')}
        hint={t('approvalAdversaryProviderHint')}
        invalidLabel={t('approvalAdversaryProviderHint')}
        {...shared}
        {...state.provider}
        onEdit={(text) => { props.edit('provider', text) }}
        onReset={() => { props.resetField('provider') }}
      />
      <ValueField
        id="plugin-config-approval-adversary-model"
        label={t('approvalAdversaryModel')}
        hint={t('approvalAdversaryModelHint')}
        invalidLabel={t('approvalAdversaryModelHint')}
        {...shared}
        {...state.model}
        onEdit={(text) => { props.edit('model', text) }}
        onReset={() => { props.resetField('model') }}
      />
      <ChoiceField
        id="plugin-config-approval-adversary-fallback"
        name="plugin-config-approval-adversary-fallback"
        label={t('approvalAdversaryFallback')}
        hint={t('approvalAdversaryFallbackHint')}
        {...shared}
        overridden={state.fallback.overridden}
        options={[
          {
            value: 'delegate',
            label: t('approvalAdversaryFallbackDelegate'),
            description: t('approvalAdversaryFallbackDelegateHint'),
            selected: state.fallback.text === 'delegate',
            pickable: true,
          },
          {
            value: 'reject',
            label: t('approvalAdversaryFallbackReject'),
            description: t('approvalAdversaryFallbackRejectHint'),
            selected: state.fallback.text === 'reject',
            pickable: true,
          },
        ]}
        onPick={(value) => { props.edit('fallback', value) }}
        onReset={() => { props.resetField('fallback') }}
      />
      <ValueField
        id="plugin-config-approval-adversary-timeout-ms"
        label={t('approvalAdversaryTimeoutMs')}
        hint={t('approvalAdversaryTimeoutMsHint')}
        invalidLabel={t('invalidNumber')}
        numeric
        {...shared}
        {...state.timeoutMs}
        onEdit={(text) => { props.edit('timeoutMs', text) }}
        onReset={() => { props.resetField('timeoutMs') }}
      />
      <ValueField
        id="plugin-config-approval-adversary-max-output-tokens"
        label={t('approvalAdversaryMaxOutputTokens')}
        hint={t('approvalAdversaryMaxOutputTokensHint')}
        invalidLabel={t('invalidNumber')}
        numeric
        {...shared}
        {...state.maxOutputTokens}
        onEdit={(text) => { props.edit('maxOutputTokens', text) }}
        onReset={() => { props.resetField('maxOutputTokens') }}
      />
      <ValueField
        id="plugin-config-approval-adversary-max-excerpt-chars"
        label={t('approvalAdversaryMaxExcerptChars')}
        hint={t('approvalAdversaryMaxExcerptCharsHint')}
        invalidLabel={t('invalidNumber')}
        numeric
        {...shared}
        {...state.maxExcerptChars}
        onEdit={(text) => { props.edit('maxExcerptChars', text) }}
        onReset={() => { props.resetField('maxExcerptChars') }}
      />
      <MultilineField
        id="plugin-config-approval-adversary-instructions"
        label={t('approvalAdversaryInstructions')}
        hint={t('approvalAdversaryInstructionsHint')}
        invalidLabel={t('approvalAdversaryInstructionsInvalid')}
        {...shared}
        {...state.instructions}
        onEdit={(text) => { props.edit('instructions', text) }}
        onReset={() => { props.resetField('instructions') }}
      />
    </PluginCard>
  )
}
