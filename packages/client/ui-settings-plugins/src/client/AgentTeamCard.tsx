/** The Agent Team card: how many teammates may exist, and how large the shared task board may grow. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { AgentTeamCardFace } from './agent-team-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the Agent Team card. */
export type AgentTeamCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<AgentTeamCardFace>

/**
 * Render the Agent Team card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function AgentTeamCard(props: AgentTeamCardProps) {
  const { t } = props
  const state = props.useAgentTeamCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="agentTeamTitle"
      descriptionKey="agentTeamDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-agent-team-max-members"
        label={t('agentTeamMaxMembers')}
        hint={t('agentTeamMaxMembersHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={!state.writable}
        {...state.maxMembers}
        onEdit={(text) => { props.edit('maxMembers', text) }}
        onReset={() => { props.resetField('maxMembers') }}
      />
      <ValueField
        id="plugin-config-agent-team-max-tasks"
        label={t('agentTeamMaxTasks')}
        hint={t('agentTeamMaxTasksHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        numeric
        disabled={!state.writable}
        {...state.maxTasks}
        onEdit={(text) => { props.edit('maxTasks', text) }}
        onReset={() => { props.resetField('maxTasks') }}
      />
    </PluginCard>
  )
}
