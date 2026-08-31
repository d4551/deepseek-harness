/**
 * Range multi-selection over one session list's rendered rows. Each list owns
 * its own selection and addresses rows in the order it renders them, so a
 * shift-click spans Workspace group boundaries exactly as the operator sees
 * them. Selection is transient view state: it lives with the mounted list and
 * is never persisted.
 */
import { useEffect, useState } from 'react'
import type { SessionNode } from './tree.ts'

/** Session identity as the rows carry it. */
type RowId = SessionNode['id']

/**
 * The contiguous rendered slice between two rows, inclusive.
 * @param ids - every selectable row in rendered order.
 * @param from - one endpoint (the anchor).
 * @param to - the other endpoint (the row just clicked).
 * @returns the slice in rendered order, or nothing when an endpoint is no longer rendered.
 */
export function rowRange(ids: readonly RowId[], from: RowId, to: RowId): readonly RowId[] {
  const start = ids.indexOf(from)
  const end = ids.indexOf(to)
  if (start === -1 || end === -1) return []
  return start <= end ? ids.slice(start, end + 1) : ids.slice(end, start + 1)
}

/** One list's live multi-selection and the gestures that edit it. */
export interface RowSelection {
  /** Selected rows in rendered order; a row that stopped rendering has already left. */
  readonly ids: readonly RowId[]
  /** Whether one row is in the selection. */
  readonly has: (id: RowId) => boolean
  /** Plain activation: this row becomes the range anchor and the selection empties. */
  readonly anchorAt: (id: RowId) => void
  /** Shift activation: select every rendered row between the anchor and this one. */
  readonly extendTo: (id: RowId) => void
  /** Ctrl/Cmd activation: add or remove this row, which also becomes the anchor. */
  readonly toggle: (id: RowId) => void
  /** Drop the selection — a bulk action committed, or Escape withdrew it. */
  readonly clear: () => void
}

/** Anchor plus raw membership; membership is reconciled against rendered rows on read. */
interface SelectionState {
  anchor: RowId | undefined
  ids: readonly RowId[]
}

const EMPTY: SelectionState = { anchor: undefined, ids: [] }

/**
 * Track a multi-selection over one list's rendered rows.
 * @param renderedIds - every selectable row the list renders, in rendered order.
 * @returns the reconciled selection and its gestures.
 */
export function useRowSelection(renderedIds: readonly RowId[]): RowSelection {
  const [state, setState] = useState<SelectionState>(EMPTY)
  // Rendered order is the account: a row that was archived, filtered out by a
  // search, or folded away leaves the selection without a reconciliation pass.
  const ids = renderedIds.filter(id => state.ids.includes(id))
  const active = ids.length > 0
  // Escape is the only exit that neither navigates nor commits, so it is worth
  // a document listener: the rows are not focusable, and the list has no
  // keyboard seat of its own to hang it on.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setState(EMPTY)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [active])
  return {
    ids,
    has: id => ids.includes(id),
    anchorAt: (id) => {
      // Every navigating click lands here, so an already-anchored row with
      // nothing selected writes no state and costs the list no render.
      if (state.anchor === id && state.ids.length === 0) return
      setState({ anchor: id, ids: [] })
    },
    extendTo: (id) => {
      // A shift-click with no prior anchor anchors itself, selecting one row.
      const anchor = state.anchor ?? id
      setState({ anchor, ids: rowRange(renderedIds, anchor, id) })
    },
    toggle: (id) => {
      setState({
        anchor: id,
        ids: ids.includes(id) ? ids.filter(selected => selected !== id) : [...ids, id],
      })
    },
    clear: () => { setState(EMPTY) },
  }
}
