import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconInspectOutline12 } from './icons/index.tsx'
import css from './InspectPill.module.css'

/**
 * Render the Inspect pill under an expanded call body.
 *
 * The pill rests at zero opacity; the owner reveals it from its own card hover
 * through the class it passes, whose descendant selector outranks the pill's
 * own single-class rule.
 * @param props.label - localized pill text, also its accessible name.
 * @param props.onClick - opens the call's trajectory record.
 * @param props.className - the owner's reveal class, composed after the shared rules.
 * @returns the pill button.
 */
export function InspectPill({ label, onClick, className }: {
  label: ReactNode
  onClick: () => void
  className?: string | undefined
}) {
  return (
    <button type="button" className={clsx(css.pill, className)} onClick={onClick}>
      <IconInspectOutline12 />
      {label}
    </button>
  )
}
