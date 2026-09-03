import type { HTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './RowSummary.module.css'

/** Ink the summary reads: the row's own outcome, not the owner's layout. */
export type RowSummaryTone = 'default' | 'error'

/**
 * Render a flow row's one-line summary.
 * @param props.tone - 'error' repaints the text for a failed row (default 'default').
 * @param props.className - an owner class composed after the shared text rules.
 * @param props - every other span attribute, including the owner's data attributes.
 * @returns the summary span.
 */
export function RowSummary({ tone = 'default', className, ...rest }: {
  tone?: RowSummaryTone
} & HTMLAttributes<HTMLSpanElement>) {
  return <span className={clsx(css.summary, tone === 'error' && css.error, className)} {...rest} />
}
