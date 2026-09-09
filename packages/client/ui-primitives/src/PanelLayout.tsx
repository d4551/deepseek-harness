import type { HTMLAttributes, ReactNode } from 'react'
import clsx from 'clsx'
import css from './PanelLayout.module.css'

/** Responsive columns for related work panels, stacked at narrow widths. */
export function PanelLayout({ children }: { children: ReactNode }) {
  return <div className={css.layout}>{children}</div>
}

/** A vertical group of panels with shared spacing. */
export function PanelStack({ children }: { children: ReactNode }) {
  return <div className={css.stack}>{children}</div>
}

/** A named panel with optional explanatory copy and header controls. */
export function PanelSection({ title, description, actions, children }: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={css.section} aria-label={title}>
      <div className={css.heading}>
        <h3 className={css.title}>{title}</h3>
        {actions}
      </div>
      {description !== undefined && <p className={css.description}>{description}</p>}
      {children}
    </section>
  )
}

/** A distinct item within a named panel. */
export function PanelEntry({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <article className={clsx(css.entry, className)} {...props} />
}

/** Wrapping controls and status metadata. */
export function PanelActions({ children }: { children: ReactNode }) {
  return <div className={css.actions}>{children}</div>
}

/** Message text retaining the sender's paragraph and line boundaries. */
export function MessageBody({ children }: { children: ReactNode }) {
  return <div className={css.message}>{children}</div>
}
