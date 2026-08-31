/**
 * Roving tab seat over one list's rendered rows. The list keeps a single tab
 * stop so the browsing region costs one Tab to enter and one to leave, and the
 * arrow keys move inside it — the tree pattern's focus rule. Every rendered row
 * takes a seat, including the ones a range cannot select: a node of a tree the
 * arrows can never reach is a node with no keyboard at all, and the rows a
 * range skips still carry verbs of their own. Like the selection, the seat is
 * transient view state and dies with the mounted list.
 */
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { isHeaderRowKey } from './selection.ts'
import type { RowKey } from './selection.ts'

/**
 * Where a focus move lands, relative to the row that owns the keystroke.
 * `parent` is the Workspace header the row sits under, which only the grouped
 * tree has.
 */
export type FocusTarget = 'previous' | 'next' | 'first' | 'last' | 'parent'

/** One list's live tab seat and the move its rows ask for. */
export interface RowFocus {
  /** The row holding the list's single tab stop; the first row until one is asked for. */
  readonly seat: RowKey | undefined
  /**
   * Move the seat and the browser's focus.
   * @param from - the row that owns the keystroke.
   * @param target - where the move lands.
   * @returns the row focus landed on, or nothing when the edge held.
   */
  readonly moveFrom: (from: RowKey, target: FocusTarget) => RowKey | undefined
}

/**
 * The account index a move lands on, clamped at both ends: the tree pattern
 * moves focus without wrapping, so the first and last rows absorb their
 * outward arrow instead of jumping across the list.
 * @param index - the moving row's index.
 * @param target - where the move lands.
 * @param keys - the account in rendered order.
 * @returns the landing index, which may be the index it started from.
 */
function landingIndex(index: number, target: FocusTarget, keys: readonly RowKey[]): number {
  switch (target) {
    case 'previous': return Math.max(index - 1, 0)
    case 'next': return Math.min(index + 1, keys.length - 1)
    case 'first': return 0
    case 'last': return keys.length - 1
    case 'parent': {
      // The header this row sits under is the nearest preceding header row.
      // A row already at the top level, and every row of the flat list, finds
      // none and holds.
      const header = keys.slice(0, index).findLastIndex(isHeaderRowKey)
      return header === -1 ? index : header
    }
  }
}

/**
 * Give the row its focus back after a move. The rows carry their key in the
 * DOM rather than a ref map: the seat moves between siblings the moving row
 * cannot reach, and the list already owns the element they render into.
 * @param list - the element the rows render into.
 * @param key - the row to focus.
 */
function focusRow(list: HTMLElement | null, key: RowKey): void {
  /* v8 ignore next -- the ref is attached to the element these rows render into. */
  if (list === null) return
  for (const element of list.querySelectorAll<HTMLElement>('[data-row-key]')) {
    if (element.dataset['rowKey'] === key) {
      element.focus()
      return
    }
  }
}

/**
 * Track one list's tab seat over its rendered rows.
 * @param renderedKeys - every row the list renders, in rendered order.
 * @param listRef - the element the rows render into, for moving focus between them.
 * @returns the reconciled seat and the move its rows ask for.
 */
export function useRowFocus(
  renderedKeys: readonly RowKey[],
  listRef: RefObject<HTMLElement | null>,
): RowFocus {
  const [seated, setSeated] = useState<RowKey | undefined>(undefined)
  // A seat whose row stopped rendering falls back to the head of the account,
  // on the same reconcile-on-read terms the selection uses.
  const seat = seated !== undefined && renderedKeys.includes(seated) ? seated : renderedKeys[0]
  // Whether the keyboard has driven this list, which is what makes a lost focus
  // this list's to recover rather than a page state to leave alone.
  const driven = useRef(false)
  // A row that leaves — archived, folded away, filtered out by a search — takes
  // the focus out of the document with it, and the browser drops it on the body.
  // The seat has already fallen back to a rendered row, so hand it the focus
  // instead of stranding the operator at the top of the page.
  useEffect(() => {
    if (!driven.current || seat === undefined) return
    if (document.activeElement !== document.body) return
    focusRow(listRef.current, seat)
  }, [seat, listRef])
  return {
    seat,
    moveFrom: (from, target) => {
      const index = renderedKeys.indexOf(from)
      /* v8 ignore next -- the row asking is the row rendered, so it is in the account. */
      if (index === -1) return undefined
      const landed = renderedKeys[landingIndex(index, target, renderedKeys)]
      driven.current = true
      if (landed === undefined || landed === from) return undefined
      setSeated(landed)
      focusRow(listRef.current, landed)
      return landed
    },
  }
}
