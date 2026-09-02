/** Model-directory request state shown above a model-selection route list. */

import type { ModelCatalogStatus } from './model-route.ts'
import css from './model-selection-card.module.css'

/** Props the owning card binds for the directory request state. */
export interface ModelCatalogStatusNoticesProps {
  /** Current model-directory request state. */
  status: ModelCatalogStatus
  /** Whether any provider-local catalog request failed while others answered. */
  partial: boolean
  /** Localized copy shown while the directory request is open. */
  loadingNotice: string
  /** Localized copy shown when the directory request failed. */
  loadFailedNotice: string
  /** Localized label of the control that reopens the directory request. */
  retryLabel: string
  /** Localized copy shown when only some providers answered. */
  partialNotice: string
  /** Whether the card forbids reopening the directory request right now. */
  retryDisabled: boolean
  /** Reopen the directory request. */
  /** Retry action; a caller may return the settlement of the underlying reload. */
  onRetry: () => unknown
}

/**
 * Render the loading, failure, and partial-result notices for one directory request.
 * @param props - Localized copy, the request state, and the retry action.
 * @returns The notices this state calls for, or nothing while the catalog is settled.
 */
export function ModelCatalogStatusNotices(props: ModelCatalogStatusNoticesProps) {
  return (
    <>
      {props.status === 'loading'
        ? <p className={css.notice} role="status">{props.loadingNotice}</p>
        : null}
      {props.status === 'error'
        ? (
          <div className={css.catalogError} role="alert">
            <span>{props.loadFailedNotice}</span>
            <button type="button" disabled={props.retryDisabled} onClick={props.onRetry}>
              {props.retryLabel}
            </button>
          </div>
        )
        : null}
      {props.partial ? <p className={css.notice}>{props.partialNotice}</p> : null}
    </>
  )
}
