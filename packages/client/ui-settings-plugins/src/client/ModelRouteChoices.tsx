/** The provider-grouped route list both model-selection cards render. */

import type { ModelRouteCandidate } from './model-route.ts'
import { groupModelRouteCandidates } from './model-route.ts'
import css from './ModelRouteChoices.module.css'

/**
 * How many routes the list accepts at once. Single selection needs one radio
 * group name so the browser treats the rows as one choice.
 */
export type ModelRouteSelection =
  | { mode: 'single'; groupName: string }
  | { mode: 'multiple' }

/** Props the owning card binds for the route list. */
export interface ModelRouteChoicesProps {
  /** Localized fieldset legend. */
  legend: string
  /** Localized marker on a row the catalog no longer advertises. */
  unavailableLabel: string
  /** Localized heading of the group holding those rows. */
  unavailableGroupLabel: string
  /** Selection arity, and the radio group name when the card takes one route. */
  selection: ModelRouteSelection
  /** Whether the card forbids changing the selection right now. */
  disabled: boolean
  /** Rows joined against the live catalog. */
  candidates: readonly ModelRouteCandidate[]
  /** Stage the row with this opaque key. */
  onPick: (key: string) => void
}

/**
 * Render the routes as one fieldset of provider groups.
 * @param props - Localized copy, selection arity, and the joined rows.
 * @returns The fieldset listing every candidate route.
 */
export function ModelRouteChoices(props: ModelRouteChoicesProps) {
  const { available, unavailable } = groupModelRouteCandidates(props.candidates)
  const inputType = props.selection.mode === 'single' ? 'radio' : 'checkbox'
  const inputName = props.selection.mode === 'single' ? props.selection.groupName : undefined

  const renderCandidate = (candidate: ModelRouteCandidate) => (
    <label key={candidate.key} className={css.model}>
      <input
        type={inputType}
        name={inputName}
        checked={candidate.selected}
        disabled={props.disabled}
        onChange={() => { props.onPick(candidate.key) }}
      />
      <span>
        <span className={css.modelName}>{candidate.modelName}</span>
        <span className={css.route}>{`${candidate.providerName} · ${candidate.provider}/${candidate.model}`}</span>
      </span>
      {!candidate.available ? <span className={css.unavailable}>{props.unavailableLabel}</span> : null}
    </label>
  )

  return (
    <fieldset className={css.models}>
      <legend>{props.legend}</legend>
      {available.map(group => (
        <div key={group.provider} className={css.modelGroup}>
          <div className={css.providerName}>{group.providerName}</div>
          {group.candidates.map(renderCandidate)}
        </div>
      ))}
      {unavailable.length > 0
        ? (
          <div className={css.modelGroup}>
            <div className={css.providerName}>{props.unavailableGroupLabel}</div>
            {unavailable.map(renderCandidate)}
          </div>
        )
        : null}
    </fieldset>
  )
}
