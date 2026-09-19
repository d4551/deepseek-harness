import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { writeClipboard } from './clipboard.ts'
import { usePointerGrace } from './pointer-grace.ts'
import { selectionIntersectsNode } from './selection-intersection.ts'
import css from './HoverCard.module.css'

/**
 * Render an anchor with a hover-triggered preview card.
 * @param props.anchor - the hover target (rendered in place inside a wrapper span).
 * @param props.content - card content; the pointer may rest on it, so it is
 * readable and selectable, but it carries no dismissal affordance of its own.
 * @param props.openDelayMs - hover dwell before the card shows (default 500).
 * @param props.disabled - suppress opening; turning true closes an open card.
 * @param props.copyText - optional primary value copied by activation and
 * included in the card's accessible name.
 * @param props.copyLabel - localized accessible activation-label prefix.
 * @param props.copiedLabel - localized visible success label.
 * @param props.presentational - hide the wrapper span from the accessibility
 * tree. Set it where the anchor is an owned child — a `treeitem` under a
 * `tree`, an `option` under a `listbox` — because a generic element between
 * the two ends the owner's claim on it.
 * @returns anchor wrapper with the conditional portaled card.
 */
export function HoverCard({
  anchor, content, openDelayMs = 500, disabled = false,
  copyText, copyLabel, copiedLabel, presentational = false,
}: {
  anchor: ReactNode
  content: ReactNode
  openDelayMs?: number
  disabled?: boolean
  copyText?: string | undefined
  copyLabel: string
  copiedLabel: string
  presentational?: boolean
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLElement>(null)
  const assignCardRef = (node: HTMLButtonElement | HTMLDivElement | null): void => {
    cardRef.current = node
  }
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyHeightRef = useRef<number | null>(null)
  const copyEpochRef = useRef(0)
  const copyingRef = useRef(false)
  const mountedRef = useRef(true)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const copyFlightRef = useRef(Promise.resolve())

  const clearCopied = useCallback(() => {
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    copyHeightRef.current = null
    setCopied(false)
  }, [])

  const close = useCallback(() => {
    copyEpochRef.current += 1
    clearCopied()
    setOpen(false)
  }, [clearCopied])

  const { arm: armClose, cancel: cancelClose } = usePointerGrace(close)

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Owner disabling mid-hover (menu opened, drag started) closes immediately.
  useEffect(() => {
    if (!disabled) return
    clearTimer()
    cancelClose()
    close()
  }, [disabled, cancelClose, close])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      copyEpochRef.current += 1
      clearTimer()
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
    }
  }, [])

  // Fixed-position from the anchor rect before paint; track the anchor while
  // open (capture-phase scroll catches nested panes), as in Menu portal mode.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const wrapper = rootRef.current
      if (wrapper === null) throw new TypeError('hover card anchor is not mounted')
      const r = wrapper.getBoundingClientRect()
      const cardEl = cardRef.current
      const h = cardEl === null ? 0 : cardEl.offsetHeight
      const top = r.top + h > window.innerHeight - 8 ? window.innerHeight - h - 8 : r.top
      setPos({ left: r.right + 8, top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  // The first placement ran before the card mounted (height read 0): once the
  // card's real height is measurable, correct the bottom-edge clamp. The
  // correction converges — a clamped top satisfies the guard, so it runs once.
  useLayoutEffect(() => {
    if (!open || pos === null) return
    const cardEl = cardRef.current
    if (cardEl === null) throw new TypeError('hover card is not mounted')
    const h = cardEl.offsetHeight
    if (pos.top + h > window.innerHeight - 8) {
      setPos({ left: pos.left, top: window.innerHeight - h - 8 })
    }
  }, [open, pos])

  const copy = async (text: string): Promise<void> => {
    if (copied || copyingRef.current) return
    copyingRef.current = true
    using _copying = { [Symbol.dispose]: () => { copyingRef.current = false } }
    const copyEpoch = copyEpochRef.current
    const accepted = await writeClipboard(text)
    const card = cardRef.current
    if (!accepted || !mountedRef.current || copyEpoch !== copyEpochRef.current || card === null) return
    const height = card.offsetHeight
    copyHeightRef.current = height > 0 ? height : null
    setCopied(true)
    copyTimerRef.current = setTimeout(clearCopied, 1000)
  }

  const queueCopy = (text: string): void => {
    const startCopy = (): Promise<void> => copy(text)
    copyFlightRef.current = copyFlightRef.current.then(startCopy, startCopy)
  }

  const copyable = copyText !== undefined
  const cardClassName = `${css.card}${copyable ? ` ${css.copyable}` : ''}${copied ? ` ${css.feedback}` : ''}`
  const cardStyle = { ...pos, minHeight: copied && copyHeightRef.current !== null ? copyHeightRef.current : undefined }
  const cardBody = copied ? <span className={css.copied} aria-hidden="true">{copiedLabel}</span> : content
  const card = open && pos !== null && (copyText !== undefined
    ? (
      <button
        ref={assignCardRef}
        type="button"
        className={cardClassName}
        style={cardStyle}
        aria-label={`${copyLabel}: ${copyText}`}
        onClick={(e) => {
          if (selectionIntersectsNode(window.getSelection(), e.currentTarget)) return
          queueCopy(copyText)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          queueCopy(copyText)
        }}
      >
        {cardBody}
      </button>
    )
    : (
      <div ref={assignCardRef} className={cardClassName} style={cardStyle}>
        {cardBody}
      </div>
    )
  )

  return (
    <span
      ref={rootRef}
      className={css.root}
      {...presentational ? { role: 'none' } : {}}
      onPointerEnter={() => {
        if (disabled) return
        // Coming back inside during the grace (the gap, or the card itself)
        // keeps the current card rather than restarting the dwell.
        cancelClose()
        if (open) return
        clearTimer()
        timerRef.current = setTimeout(() => { setOpen(true) }, openDelayMs)
      }}
      onPointerLeave={() => {
        clearTimer()
        // Leaving a closed card schedules a no-op close; only arm while
        // open, matching Menu's shape.
        if (open) armClose()
      }}
      // A press inside the anchor (row click, menu trigger) dismisses the
      // card immediately, without waiting for the owner to flip `disabled`.
      // Capture presses reach this handler from the card too — it is a React
      // child of the wrapper — but a press there starts a selection, so the
      // card must stay mounted under it (and the browser's click with it).
      onPointerDownCapture={(e) => {
        const target = e.target
        if (target instanceof Node && cardRef.current?.contains(target) === true) return
        clearTimer()
        cancelClose()
        close()
      }}
    >
      {anchor}
      {open && copyable && <output className="dsw-visually-hidden">{copied ? copiedLabel : ''}</output>}
      {card !== false && createPortal(card, document.body)}
    </span>
  )
}
