import type { HTMLAttributes } from 'react'
import clsx from 'clsx'
import css from './FlowRow.module.css'

/**
 * Render one line of the conversation flow.
 *
 * The owner keeps its own row rules — state overlays, hover previews, cursor —
 * on the class it passes, which the row line's own class never outranks.
 * @param props.className - the owner's row class, composed after the shared line.
 * @param props - every other div attribute, including the owner's row data attributes.
 * @returns the row element.
 */
export function FlowRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(css.row, className)} {...rest} />
}
