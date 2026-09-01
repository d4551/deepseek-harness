/**
 * Roving tab seat over one list's rendered rows. The rows themselves hold one
 * tab stop between them and the arrow keys move it — the tree pattern's focus
 * rule. Tab does not leave the region from there: focus on a row reveals that
 * row's trailing verbs, which are buttons of their own, so Tab walks them
 * before it leaves. Every rendered row
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

/**
 * How long a type-ahead buffer collects characters before the next one starts a
 * fresh search. One second is long enough to finish a word at ordinary typing
 * speed and short enough that a stale prefix never answers for an unrelated
 * keystroke.
 */
export const TYPE_AHEAD_MS = 1000

/** One list's live tab seat and the moves its rows ask for. */
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
  /**
   * Move the seat to the next row whose label starts with what has been typed
   * — the tree pattern's type-ahead, which a sidebar of more than a handful of
   * rows needs to be navigable by keyboard at all.
   * @param from - the row that owns the keystroke.
   * @param character - the printable character typed.
   * @returns the row focus landed on, or nothing when no label matched.
   */
  readonly typeAheadFrom: (from: RowKey, character: string) => RowKey | undefined
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
 * The row a type-ahead lands on: the first row whose label starts with the
 * buffer, searched from the row the keystroke came from and wrapping through
 * the head of the list.
 * @param rows - every rendered row's key and label, in rendered order.
 * @param from - the row the keystroke came from.
 * @param prefix - the buffered characters, lowercased.
 * @param past - start the search after `from` rather than at it, so a repeated
 * character walks the rows beginning with it instead of holding the first.
 * @returns the landing row, or nothing when no label starts with the prefix.
 */
function typeAheadLanding(
  rows: readonly { key: RowKey; label: string }[],
  from: RowKey,
  prefix: string,
  past: boolean,
): RowKey | undefined {
  const index = rows.findIndex(row => row.key === from)
  const start = index + (past ? 1 : 0)
  for (let step = 0; step < rows.length; step += 1) {
    const row = rows[(start + step + rows.length) % rows.length]
    if (row !== undefined && row.label.toLowerCase().startsWith(prefix)) return row.key
  }
  return undefined
}

/**
 * Every rendered row's key and label, in rendered order. The rows carry both in
 * the DOM for the same reason the focus moves by attribute: the list owns the
 * element they render into and the searching row cannot reach its siblings.
 * @param list - the element the rows render into.
 * @returns the account a type-ahead searches.
 */
function labelledRows(list: HTMLElement): { key: RowKey; label: string }[] {
  const rows: { key: RowKey; label: string }[] = []
  for (const element of list.querySelectorAll<HTMLElement>('[data-row-key][data-row-label]')) {
    const key = element.dataset['rowKey']
    const label = element.dataset['rowLabel']
    /* v8 ignore next -- the selector already required both attributes. */
    if (key === undefined || label === undefined) continue
    rows.push({ key, label })
  }
  return rows
}

/**
 * Give the row its focus back after a move. The rows carry their key in the
 * DOM rather than a ref map: the seat moves between siblings the moving row
 * cannot reach, and the list already owns the element they render into.
 * @param list - the element the rows render into.
 * @param key - the row to focus.
 */
function focusRow(list: HTMLElement, key: RowKey): void {
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
  // Whether the focus is inside this list, which is what makes a lost focus
  // this list's to recover rather than a page state to leave alone. The two
  // document listeners below keep it live.
  const held = useRef(false)
  useEffect(() => {
    const list = listRef.current
    /* v8 ignore next -- the ref is attached to the element these rows render into. */
    if (list === null) return
    const arrive = (): void => { held.current = list.contains(document.activeElement) }
    const leave = (event: FocusEvent): void => {
      // A row that leaves takes the focus with it without saying where it
      // went: a browser reports that blur with the row already detached, and
      // jsdom reports none at all, so neither reading gives the recovery up.
      // A focus dropped on purpose blurs an element still in the document.
      /* v8 ignore next -- jsdom fires no focusout for a removed row; a browser fires one already detached. */
      if (!(event.target as Node).isConnected) return
      if (event.relatedTarget === null) held.current = false
    }
    arrive()
    document.addEventListener('focusin', arrive)
    document.addEventListener('focusout', leave)
    return () => {
      document.removeEventListener('focusin', arrive)
      document.removeEventListener('focusout', leave)
    }
  }, [listRef])
  // A row that leaves — archived, folded away, filtered out by a search — takes
  // the focus out of the document with it, and the browser drops it on the body.
  // The seat has already fallen back to a rendered row, so hand it the focus
  // instead of stranding the operator at the top of the page.
  // The reconciled seat is not the only row that can leave: the focus may sit
  // on a row the seat never moved to, so the recovery is checked after every
  // render rather than only when the seat itself changes.
  useEffect(() => {
    const list = listRef.current
    /* v8 ignore next -- the ref is attached to the element these rows render into. */
    if (list === null) return
    if (seat !== undefined && held.current && document.activeElement === document.body) {
      focusRow(list, seat)
    }
  })
  // The characters typed so far, whether they are all the same one, and when
  // the last arrived. A gap longer than the window starts a fresh search rather
  // than extending a prefix the operator has stopped thinking about.
  const typed = useRef({ text: '', repeat: true, at: 0 })
  return {
    seat,
    typeAheadFrom: (from, character) => {
      const list = listRef.current
      /* v8 ignore next -- the row asking for the search rendered into this list. */
      if (list === null) return undefined
      const now = Date.now()
      const fresh = now - typed.current.at > TYPE_AHEAD_MS
      const text = fresh ? character : typed.current.text + character
      // Repeating one character walks the rows that begin with it, so a buffer
      // of nothing else collapses back to that character rather than growing
      // past every label in the list.
      const repeat = fresh
        || (typed.current.repeat && character === typed.current.text.slice(0, character.length))
      typed.current = { text, repeat, at: now }
      const prefix = (repeat ? character : text).toLowerCase()
      const landed = typeAheadLanding(labelledRows(list), from, prefix, repeat)
      if (landed === undefined || landed === from) return undefined
      setSeated(landed)
      focusRow(list, landed)
      return landed
    },
    moveFrom: (from, target) => {
      const index = renderedKeys.indexOf(from)
      /* v8 ignore next -- the row asking is the row rendered, so it is in the account. */
      if (index === -1) return undefined
      const landed = renderedKeys[landingIndex(index, target, renderedKeys)]
      if (landed === undefined || landed === from) return undefined
      setSeated(landed)
      /* v8 ignore next -- the row asking for the move rendered into this list. */
      if (listRef.current !== null) focusRow(listRef.current, landed)
      return landed
    },
  }
}
