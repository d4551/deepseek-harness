/**
 * Keep a fixed-position floating element anchored to a trigger.
 *
 * A portaled panel is positioned from its anchor's viewport rect, which stops
 * being true the moment anything scrolls or the window resizes. This owns that
 * one concern: measure the anchor, offset the panel below it, clamp the result
 * inside the viewport, and re-run on scroll (capture phase, so scrollers nested
 * inside the page are caught too), on resize, and on the panel's own size
 * changes while the element is open.
 * @module @deepseek-ai/dsh-client-ui-primitives/useAnchoredPosition
 */

import { useId, useLayoutEffect, useState, type RefObject } from 'react'

/** Inputs for {@link useAnchoredPosition}. */
export interface AnchoredPositionOptions {
  /** Whether the floating element is mounted and should track its anchor. */
  open: boolean
  /** The element the panel is placed from. */
  anchorRef: RefObject<HTMLElement | null>
  /** The floating element, measured so the clamp uses real dimensions. */
  panelRef: RefObject<HTMLElement | null>
  /** Owning portal element; a change remounts the panel and renews its observer. */
  portalHost?: HTMLElement
  /** A caller-owned anchor, such as a context-menu request's pointer position. */
  getAnchorRect?: (() => DOMRect | null) | undefined
  /** Edge of the anchor where the panel opens. */
  side?: 'bottom' | 'top' | 'right'
  /** Horizontal alignment for a panel above or below the anchor. */
  align?: 'start' | 'end'
  /** Try the opposite anchor edge before clamping an overflowing panel. */
  flip?: boolean
  /** Distance kept between the anchor's bottom edge and the panel's top. */
  gap: number
  /** Distance kept between the panel and each viewport edge. */
  margin: number
}

/**
 * Track an anchor through an owned stylesheet without inline declarations.
 * @param options - the open state, the two refs, and the gap/margin distances.
 * @returns the panel's `data-anchored-position` identity, or `null` before measurement.
 */
export function useAnchoredPosition(options: AnchoredPositionOptions): string | null {
  const { open, anchorRef, panelRef, portalHost, getAnchorRect, side = 'bottom', align = 'start', flip = false, gap, margin } = options
  const identity = useId()
  const [position, setPosition] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const sheet = new CSSStyleSheet()
    document.adoptedStyleSheets.push(sheet)
    const place = () => {
      const rect = getAnchorRect === undefined ? anchorRef.current?.getBoundingClientRect() : getAnchorRect()
      if (rect == null) {
        setPosition(null)
        return
      }
      const panel = panelRef.current
      const width = panel?.offsetWidth ?? 0
      const height = panel?.offsetHeight ?? 0
      let left = side === 'right' ? rect.right + gap : align === 'end' ? rect.right - width : rect.left
      let top = side === 'right' ? rect.top : side === 'top' ? rect.top - height - gap : rect.bottom + gap
      if (flip) {
        if (side === 'right') {
          const opposite = rect.left - width - gap
          if (left + width > window.innerWidth - margin && opposite >= margin) left = opposite
        } else {
          const above = rect.top - height - gap
          const below = rect.bottom + gap
          if (side === 'bottom' && top + height > window.innerHeight - margin && above >= margin) top = above
          if (side === 'top' && top < margin && below + height <= window.innerHeight - margin) top = below
          const opposite = align === 'start' ? rect.right - width : rect.left
          if ((left < margin || left + width > window.innerWidth - margin)
            && opposite >= margin && opposite + width <= window.innerWidth - margin) left = opposite
        }
      }
      if (width > 0) left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
      if (height > 0) top = Math.max(margin, Math.min(top, window.innerHeight - height - margin))
      sheet.replaceSync(`[data-anchored-position="${CSS.escape(identity)}"] { left: ${left}px; top: ${top}px; }`)
      setPosition(identity)
    }
    // The first run measures the panel in the same commit that opened it, so
    // the clamp uses real dimensions before anything paints.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // Panel content and resizable textareas change size without window events.
    const panel = panelRef.current
    let observer: ResizeObserver | null = null
    if (panel !== null) {
      observer = new ResizeObserver(place)
      observer.observe(panel)
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(adopted => adopted !== sheet)
    }
  }, [open, anchorRef, panelRef, portalHost, getAnchorRect, side, align, flip, gap, margin, identity])
  return position
}
