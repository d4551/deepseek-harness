import type { ReactNode } from 'react'
import clsx from 'clsx'
import css from './ResultText.module.css'

/**
 * Render a call's flattened result text as a code panel.
 * @param props.error - the call failed, so the text takes the error ink.
 * @param props.className - an owner class composed after the shared panel rules.
 * @param props.children - the flattened result text.
 * @returns the preformatted panel.
 */
export function ResultText({ error = false, className, children }: {
  error?: boolean | undefined
  className?: string | undefined
  children: ReactNode
}) {
  return <pre className={clsx(css.text, className)} data-error={error || undefined}>{children}</pre>
}
