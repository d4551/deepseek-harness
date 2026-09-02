/** The approval assessor's card: whether approval reasons are screened, and with what extra patterns. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { ApprovalAssessorCardFace } from './approval-assessor-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the approval-assessor card. */
export type ApprovalAssessorCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<ApprovalAssessorCardFace>

/**
 * Render the approval-assessor card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function ApprovalAssessorCard(props: ApprovalAssessorCardProps) {
  const { t } = props
  const state = props.useApprovalAssessorCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="approvalAssessorTitle"
      descriptionKey="approvalAssessorDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-approval-assessor-enabled"
        label={t('approvalAssessorEnabled')}
        hint={t('approvalAssessorEnabledHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidBoolean')}
        disabled={!state.writable}
        placeholder={t('approvalAssessorEnabledPlaceholder')}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <ValueField
        id="plugin-config-approval-assessor-patterns"
        label={t('approvalAssessorExtraPatterns')}
        hint={t('approvalAssessorExtraPatternsHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidBoolean')}
        disabled={!state.writable}
        {...state.extraPatterns}
        onEdit={(text) => { props.edit('extraPatterns', text) }}
        onReset={() => { props.resetField('extraPatterns') }}
      />
    </PluginCard>
  )
}
