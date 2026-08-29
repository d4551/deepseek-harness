import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './OnboardingSurface.module.css'

/**
 * Render a body-portaled onboarding stage and keep the application root inert
 * while mounted.
 *
 * The stage is a modal dialog, not decoration: it covers the application and
 * makes the root inert, so assistive technology has to see one named surface
 * that owns the interaction rather than loose content beside an inert page.
 * @param props.label - localized accessible name for the stage, supplied by the render site.
 * @param props.children - the step's page content, centered on the stage.
 * @returns the body-portaled overlay tree.
 */
export function OnboardingSurface({ label, children }: { label: string; children: ReactNode }) {
  useEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    appRoot.inert = true
    return () => { appRoot.inert = false }
  }, [])

  return createPortal((
    <div className={css.onboardingOverlay} role="presentation">
      <div className={css.onboardingMask} aria-hidden="true" />
      <div className={css.onboardingStage} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  ), document.body)
}
