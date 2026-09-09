import type { ReactNode } from 'react'
import css from './SettingsDisclosure.module.css'

/** Labels a plugin's controls inside the shared settings flow. */
export function SettingsFields(props: { title: string; description: string; children: ReactNode }) {
  return (
    <fieldset className={css.fields}>
      <legend className={css.legend}>{props.title}</legend>
      <p className={css.description}>{props.description}</p>
      {props.children}
    </fieldset>
  )
}
