/** User control for the default model of future Agent sessions. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentDefaultModelCardFace } from './agent-default-model-card-controller.ts'
import type {} from './slot-contract.ts'
import { AGENT_DEFAULT_MODEL_NS } from './agent-default-model-card-controller.ts'
import { ModelCatalogStatusNotices } from './ModelCatalogStatusNotices.tsx'
import { ModelRouteChoices } from './ModelRouteChoices.tsx'
import { PluginCard } from './PluginCard.tsx'
import css from './model-selection-card.module.css'

/** Props the renderer binds for the default-model card. */
export type AgentDefaultModelCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<AgentDefaultModelCardFace>

/**
 * Render the staged single-route default model selection.
 * @param props - locale copy, the card snapshot, and its selection action.
 * @returns the preference card, or nothing when the namespace is unavailable.
 */
export function AgentDefaultModelCard(props: AgentDefaultModelCardProps) {
  const { t } = props
  const state = props.useAgentDefaultModelCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="agentDefaultModelTitle"
      descriptionKey="agentDefaultModelDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.selection}>
        <ModelCatalogStatusNotices
          status={state.catalogStatus}
          partial={state.catalogPartial}
          loadingNotice={t('agentDefaultModelLoading')}
          loadFailedNotice={t('agentDefaultModelLoadFailed')}
          retryLabel={t('agentDefaultModelRetry')}
          partialNotice={t('agentDefaultModelPartial')}
          retryDisabled={state.saving}
          onRetry={props.retryCatalog}
        />
        {state.candidates.length > 0
          ? (
            <ModelRouteChoices
              legend={t('agentDefaultModelChoose')}
              unavailableLabel={t('agentDefaultModelUnavailable')}
              unavailableGroupLabel={t('agentDefaultModelUnavailableGroup')}
              selection={{ mode: 'single', groupName: AGENT_DEFAULT_MODEL_NS }}
              disabled={!state.writable || state.saving}
              candidates={state.candidates}
              onPick={props.selectModel}
            />
          )
          : state.catalogStatus === 'ready'
            ? <p className={css.notice}>{t('agentDefaultModelEmpty')}</p>
            : null}
      </div>
      {state.conflicted
        ? <p className={css.conflict} role="status">{t('agentDefaultModelConflict')}</p>
        : null}
    </PluginCard>
  )
}
