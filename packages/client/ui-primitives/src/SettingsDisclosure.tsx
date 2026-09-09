import { useId, type ReactNode } from 'react'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from './icons/index.tsx'
import css from './SettingsDisclosure.module.css'

export interface SettingsDisclosureProps {
  title: string
  toggleLabel: string
  open: boolean
  busy: boolean
  onToggle: () => boolean
  status: ReactNode
  children: ReactNode
}

/** Settings accordion with a persistent panel and a native keyboard-operable heading. */
export function SettingsDisclosure(props: SettingsDisclosureProps) {
  const bodyId = useId()
  return (
    <div className={css.surface}>
      <h3 className={css.heading}>
        <button
          className={css.trigger}
          type="button"
          data-disclosure-row
          aria-label={props.toggleLabel}
          aria-expanded={props.open}
          aria-controls={bodyId}
          onClick={props.onToggle}
        >
          {props.open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          <span className={css.title}>{props.title}</span>
          {props.status}
        </button>
      </h3>
      <div id={bodyId} className={css.panel} hidden={!props.open} aria-busy={props.busy}>
        {props.children}
      </div>
    </div>
  )
}
