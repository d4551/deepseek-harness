import { createElement } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ChoiceField, MultilineField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { ApprovalAssessorCardFace } from './approval-assessor-card-controller.ts'
import type {} from './slot-contract.ts'

export type ApprovalAssessorCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<ApprovalAssessorCardFace>

export function ApprovalAssessorCard(props: ApprovalAssessorCardProps) {
  const { t } = props
  const state = props.useApprovalAssessorCard(snapshot => snapshot)
  const choices = [
    {
      value: 'true',
      label: t('approvalAssessorEnabledOn'),
      description: t('approvalAssessorEnabledOnHint'),
      selected: state.enabled.text === 'true',
      pickable: true,
    },
    {
      value: 'false',
      label: t('approvalAssessorEnabledOff'),
      description: t('approvalAssessorEnabledOffHint'),
      selected: state.enabled.text === 'false',
      pickable: true,
    },
  ]
  const controls = [
    createElement(ChoiceField, {
      key: 'enabled',
      id: 'plugin-config-approval-assessor-enabled',
      name: 'plugin-config-approval-assessor-enabled',
      label: t('approvalAssessorEnabled'),
      hint: t('approvalAssessorEnabledHint'),
      overriddenLabel: t('overridden'),
      resetLabel: t('reset'),
      disabled: !state.writable,
      overridden: state.enabled.overridden,
      options: choices,
      onPick: (value) => { props.edit('enabled', value) },
      onReset: () => { props.resetField('enabled') },
    }),
    createElement(MultilineField, {
      key: 'extraPhrases',
      id: 'plugin-config-approval-assessor-extra-phrases',
      label: t('approvalAssessorExtraPhrases'),
      hint: t('approvalAssessorExtraPhrasesHint'),
      overriddenLabel: t('overridden'),
      resetLabel: t('reset'),
      invalidLabel: t('approvalAssessorExtraPhrasesInvalid'),
      disabled: !state.writable,
      ...state.extraPhrases,
      onEdit: (text) => { props.edit('extraPhrases', text) },
      onReset: () => { props.resetField('extraPhrases') },
    }),
  ]
  return createElement(
    PluginCard,
    {
      t,
      titleKey: 'approvalAssessorTitle',
      descriptionKey: 'approvalAssessorDescription',
      state,
      onSave: props.save,
      onDiscard: props.discard,
      children: controls,
    },
  )
}
