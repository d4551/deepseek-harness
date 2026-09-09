import type { ComponentProps } from 'react'
import { Button } from './Button.tsx'
import css from './SettingsDisclosure.module.css'

export interface SettingsActionsProps {
  saveLabel: string
  discardLabel: string
  saveDisabled: boolean
  discardDisabled: boolean
  onSave: ComponentProps<typeof Button>['onClick']
  onDiscard: ComponentProps<typeof Button>['onClick']
}

/** Shared settings actions with wrapping layout and touch-sized controls. */
export function SettingsActions(props: SettingsActionsProps) {
  return (
    <div className={css.actions}>
      <Button variant="outline" size="touch" disabled={props.discardDisabled} onClick={props.onDiscard}>
        {props.discardLabel}
      </Button>
      <Button variant="primary" size="touch" disabled={props.saveDisabled} onClick={props.onSave}>
        {props.saveLabel}
      </Button>
    </div>
  )
}
