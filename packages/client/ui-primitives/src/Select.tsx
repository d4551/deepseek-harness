import type { ComponentPropsWithRef } from 'react'
import css from './FormControl.module.css'

/** Native keyboard and mobile selection with the shared field treatment. */
export function Select(props: Omit<ComponentPropsWithRef<'select'>, 'className' | 'style'>) {
  return <select {...props} className={css.select} />
}
