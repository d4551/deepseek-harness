import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { RequestBudgetCardFace } from './request-budget-card-controller.ts'
import type {} from './slot-contract.ts'

/** Framework-bound request budget settings card. */
export type RequestBudgetCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<RequestBudgetCardFace>

/** Shows task and delegated-agent request ceilings from the served namespace. */
export function RequestBudgetCard(props: RequestBudgetCardProps) {
  const { t } = props
  const state = props.useRequestBudgetCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="requestBudgetTitle"
      descriptionKey="requestBudgetDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-request-budget-task"
        label={t('requestBudgetTask')}
        hint={t('requestBudgetTaskHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('requestBudgetInvalid')}
        numeric
        disabled={!state.writable}
        {...state.maxRootAttempts}
        onEdit={(text) => { props.edit('maxRootAttempts', text) }}
        onReset={() => { props.resetField('maxRootAttempts') }}
      />
      <ValueField
        id="plugin-config-request-budget-agent"
        label={t('requestBudgetAgent')}
        hint={t('requestBudgetAgentHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('requestBudgetInvalid')}
        numeric
        disabled={!state.writable}
        {...state.maxAgentAttempts}
        onEdit={(text) => { props.edit('maxAgentAttempts', text) }}
        onReset={() => { props.resetField('maxAgentAttempts') }}
      />
    </PluginCard>
  )
}
