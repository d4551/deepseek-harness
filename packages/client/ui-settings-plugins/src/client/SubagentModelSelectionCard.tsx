/** User control for model-selectable subagent delegation in new sessions. */

import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentModelSelectionCardFace } from './subagent-model-selection-card-controller.ts'
import type {} from './slot-contract.ts'
import { ModelCatalogStatusNotices } from './ModelCatalogStatusNotices.tsx'
import { ModelRouteChoices } from './ModelRouteChoices.tsx'
import { PluginCard } from './PluginCard.tsx'
import css from './model-selection-card.module.css'

/** Props the renderer binds for the subagent model-selection card. */
export type SubagentModelSelectionCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<SubagentModelSelectionCardFace>

/**
 * Render the default-off preference and its exact provider/model route choices.
 * @param props - locale copy, the card snapshot, and its toggle action.
 * @returns the preference card, or nothing when the namespace is unavailable.
 */
export function SubagentModelSelectionCard(props: SubagentModelSelectionCardProps) {
  const { t } = props
  const state = props.useSubagentModelSelectionCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="subagentModelSelectionTitle"
      descriptionKey="subagentModelSelectionDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.permission}>
        <div className={css.toggleRow}>
          <span className={css.toggleLabel}>{t('subagentModelSelectionToggle')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={state.enabled}
            aria-label={t('subagentModelSelectionToggle')}
            className={clsx(css.switch, state.enabled && css.switchOn)}
            disabled={!state.writable || state.saving}
            onClick={props.toggleEnabled}
          >
            <span className={css.thumb} />
          </button>
        </div>
        <p className={css.hint}>
          {t(state.enabled ? 'subagentModelSelectionChoose' : 'subagentModelSelectionOff')}
        </p>
      </div>
      {state.enabled
        ? (
          <div className={css.selection}>
            <ModelCatalogStatusNotices
              status={state.catalogStatus}
              partial={state.catalogPartial}
              loadingNotice={t('subagentModelSelectionLoading')}
              loadFailedNotice={t('subagentModelSelectionLoadFailed')}
              retryLabel={t('subagentModelSelectionRetry')}
              partialNotice={t('subagentModelSelectionPartial')}
              retryDisabled={state.saving}
              onRetry={props.retryCatalog}
            />
            {state.candidates.length > 0
              ? (
                <ModelRouteChoices
                  legend={t('subagentModelSelectionAllowed')}
                  unavailableLabel={t('subagentModelSelectionUnavailable')}
                  unavailableGroupLabel={t('subagentModelSelectionUnavailableGroup')}
                  selection={{ mode: 'multiple' }}
                  disabled={!state.writable || state.saving}
                  candidates={state.candidates}
                  onPick={props.toggleModel}
                />
              )
              : state.catalogStatus === 'ready'
                ? <p className={css.notice}>{t('subagentModelSelectionEmpty')}</p>
                : null}
            {state.invalid ? <p className={css.invalid}>{t('subagentModelSelectionRequired')}</p> : null}
          </div>
        )
        : null}
      {state.conflicted
        ? <p className={css.conflict} role="status">{t('subagentModelSelectionConflict')}</p>
        : null}
    </PluginCard>
  )
}
