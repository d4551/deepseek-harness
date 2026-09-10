import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FocusEventHandler, MouseEventHandler, ReactElement } from 'react'
import { usePointerGrace } from './pointer-grace.ts'
import css from './Tooltip.module.css'

/** Bubble placement relative to the anchor. */
export type TooltipSide = 'right' | 'bottom' | 'top'

interface AnchorProps {
  'data-tooltip-trigger'?: string
  'aria-describedby'?: string | undefined
  onMouseEnter?: MouseEventHandler | undefined
  onMouseLeave?: MouseEventHandler | undefined
  onFocus?: FocusEventHandler | undefined
  onBlur?: FocusEventHandler | undefined
}

type TooltipLabel = string | (() => string)

/**
 * Describe an existing control with a keyboard and pointer tooltip.
 * @param props.label - text, resolved only while displayed.
 * @param props.side - preferred placement; native CSS positioning handles viewport edges.
 * @param props.delayMs - pointer delay; keyboard focus displays the description immediately.
 * @param props.disabled - whether the description is unavailable.
 * @param props.constrainToAnchor - cap long descriptions at their control's width.
 * @param props.children - control whose layout, ref, and event handlers are retained.
 * @returns the control and its associated description.
 */
export function Tooltip({ label, side = 'right', delayMs = 0, disabled = false, constrainToAnchor = false, children }: {
  label: TooltipLabel
  side?: TooltipSide
  delayMs?: number
  disabled?: boolean
  constrainToAnchor?: boolean
  children: ReactElement<AnchorProps>
}) {
  const id = useId()
  const anchorName = `--tooltip-${id.replaceAll(':', '')}`
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggers = useRef({ hover: false, focus: false })
  const { arm: scheduleHide, cancel: cancelHide } = usePointerGrace(() => { setVisible(false) })
  const cancelShow = useCallback(() => {
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
  }, [])

  useEffect(() => {
    if (disabled) {
      cancelShow()
      cancelHide()
      triggers.current = { hover: false, focus: false }
      setVisible(false)
    }
    return cancelShow
  }, [cancelHide, cancelShow, disabled])

  useEffect(() => {
    if (!visible) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelHide()
      setVisible(false)
    }
    document.addEventListener('keydown', dismiss)
    return () => { document.removeEventListener('keydown', dismiss) }
  }, [cancelHide, visible])

  const showAfterHoverDelay = () => {
    cancelShow()
    cancelHide()
    if (disabled) return
    if (delayMs <= 0) setVisible(true)
    else timer.current = setTimeout(() => {
      timer.current = null
      setVisible(true)
    }, delayMs)
  }

  const description = visible ? [children.props['aria-describedby'], id].filter(Boolean).join(' ') : children.props['aria-describedby']
  return (
    <>
      {cloneElement(children, {
        'data-tooltip-trigger': anchorName,
        'aria-describedby': description,
        onMouseEnter: (event) => { children.props.onMouseEnter?.(event); triggers.current.hover = true; showAfterHoverDelay() },
        onMouseLeave: (event) => {
          children.props.onMouseLeave?.(event)
          triggers.current.hover = false
          cancelShow()
          if (!triggers.current.focus) scheduleHide()
        },
        onFocus: (event) => {
          children.props.onFocus?.(event)
          triggers.current.focus = true
          cancelShow()
          cancelHide()
          if (!disabled) setVisible(true)
        },
        onBlur: (event) => {
          children.props.onBlur?.(event)
          triggers.current.focus = false
          cancelShow()
          if (!triggers.current.hover) setVisible(false)
        },
      })}
      {visible && (
        <span
          id={id}
          className={css.bubble}
          data-tooltip-anchor={anchorName}
          data-side={side}
          data-constrained={constrainToAnchor || undefined}
          role="tooltip"
          onMouseEnter={() => { triggers.current.hover = true; cancelHide() }}
          onMouseLeave={() => { triggers.current.hover = false; if (!triggers.current.focus) scheduleHide() }}
        >
          {typeof label === 'function' ? label() : label}
        </span>
      )}
    </>
  )
}
