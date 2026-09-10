import { useEffect, useId, useRef } from 'react'
import type { ReactNode, Ref } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCloseOutline16 } from './icons/index.tsx'
import css from './Modal.module.css'

interface ModalBaseProps {
  ref?: Ref<HTMLDivElement>
  open: boolean
  onClose: () => void
  description?: string
  children?: ReactNode
  footer?: ReactNode
  headerActions?: ReactNode
  navigation?: ReactNode
  className?: string
  contentClassName?: string
  size?: 'compact' | 'workspace'
}

type ModalProps = ModalBaseProps & (
  | { headless: true; title: string; closeLabel?: never; initialFocus?: never }
  | { headless?: false; title: ReactNode; closeLabel: ReactNode; initialFocus?: 'dialog' | 'close' }
)

/**
 * Render a centered, body-portaled modal over a blurred page mask.
 * @param props.open - whether the dialog is showing.
 * @param props.ref - dialog element for focus and imperative accessibility checks.
 * @param props.onClose - Escape or mask click.
 * @param props.title - visible heading, or accessible name in headless mode.
 * @param props.closeLabel - localized accessible close-button label.
 * @param props.description - optional supporting sentence under the title.
 * @param props.children - body (inputs, etc.).
 * @param props.footer - action row (Cancel / Create).
 * @param props.contentClassName - optional class for a scrollable content region.
 * @param props.headless - render children directly in the card (no default
 * header/close/body chrome); mask, card, Escape, and aria-label remain.
 * @returns null when closed; otherwise the overlay tree.
 */
export function Modal({
  open, onClose, title, closeLabel, description, children, footer, headerActions, navigation,
  className, contentClassName, ref, headless = false, size = 'compact', initialFocus = 'dialog',
}: ModalProps) {
  const titleId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const root = rootRef.current
    const dialog = root?.querySelector<HTMLElement>('[role="dialog"]')
    if (root === null || dialog == null) return
    const previousFocus = document.activeElement
    const siblings = new Map<HTMLElement, boolean>()
    for (const element of document.body.children) {
      if (element instanceof HTMLElement && element !== root) {
        siblings.set(element, element.inert)
        element.inert = true
      }
    }
    if (!dialog.contains(document.activeElement)) {
      const target = initialFocus === 'close' ? closeRef.current : dialog
      target?.focus()
    }
    const containFocus = (event: FocusEvent) => {
      if (root.inert) return
      if (event.target instanceof Node && !root.contains(event.target)) dialog.focus()
    }
    const cycleFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || root.inert) return
      const controls = [...dialog.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]',
      )].filter(element => element.tabIndex >= 0 && !element.matches(':disabled')
        && element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'))
      const first = controls[0]
      const last = controls.at(-1)
      if (first === undefined || last === undefined) {
        event.preventDefault()
        dialog.focus()
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('focusin', containFocus)
    document.addEventListener('keydown', cycleFocus)
    return () => {
      document.removeEventListener('focusin', containFocus)
      document.removeEventListener('keydown', cycleFocus)
      for (const [element, inert] of siblings) element.inert = inert
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [open, initialFocus])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      const root = rootRef.current
      if (e.key === 'Escape' && !e.defaultPrevented && !root?.inert
        && root?.querySelector('[role="menu"]') === null) onClose()
    }
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      const dialog = root?.querySelector('[role="dialog"]')
      if (root === null || root.inert || dialog == null) return
      if (event.target instanceof Node && !dialog.contains(event.target)) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal((
    <div ref={rootRef} className={css.root} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        className={clsx(css.dialog, size === 'workspace' && css.workspace, className)}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        aria-labelledby={typeof title === 'string' ? undefined : titleId}
        tabIndex={-1}
      >
        {headless
          ? children
          : (
            <>
              <div className={css.header}>
                <h2 id={titleId} className={css.title}>{title}</h2>
                {headerActions}
                <button
                  ref={closeRef}
                  type="button"
                  className={css.close}
                  aria-label={typeof closeLabel === 'string' ? closeLabel : undefined}
                  onClick={onClose}
                >
                  <IconCloseOutline16 size={14} />
                  {typeof closeLabel !== 'string' && <span className="dsw-visually-hidden">{closeLabel}</span>}
                </button>
              </div>
              {navigation !== undefined && <div className={css.navigation}>{navigation}</div>}
              <div className={clsx(css.content, contentClassName)}>
                {description !== undefined && description !== '' && (
                  <p className={css.description}>{description}</p>
                )}
                {children !== undefined && <div className={css.body}>{children}</div>}
              </div>
              {footer !== undefined && <div className={css.footer}>{footer}</div>}
            </>
          )}
      </div>
    </div>
  ), document.body)
}
