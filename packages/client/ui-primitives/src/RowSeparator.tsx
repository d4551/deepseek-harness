import clsx from 'clsx'
import css from './RowSeparator.module.css'

/**
 * Render the meta separator dot between a flow row's title and its summary.
 * @param props.className - an owner class that retints the dot; it must outrank
 * a single class selector, since sheet order between packages is not fixed.
 * @returns the decorative dot.
 */
export function RowSeparator({ className }: { className?: string | undefined }) {
  return <span className={clsx(css.dot, className)} aria-hidden />
}
