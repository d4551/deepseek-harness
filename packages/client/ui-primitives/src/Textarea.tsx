import type { ComponentPropsWithRef } from 'react'
import css from './FormControl.module.css'

/** Multiline form control using the shared field surface and focus treatment. */
export function Textarea(props: Omit<ComponentPropsWithRef<'textarea'>, 'className' | 'style'>) {
  return <textarea {...props} className={css.textarea} />
}
