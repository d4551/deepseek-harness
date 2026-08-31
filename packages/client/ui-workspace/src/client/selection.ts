/**
 * Range multi-selection over one list's rendered rows. Each list owns its own
 * selection and addresses rows in the order it renders them, so a shift-click
 * spans Workspace group boundaries — and the Workspace header rows themselves —
 * exactly as the operator sees them. Selection is transient view state: it
 * lives with the mounted list and is never persisted.
 */
import { useEffect, useState } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * One selectable row's key. The two row kinds share one ordered account, so
 * their keys share one namespace and carry the kind that produced them.
 */
export type RowKey = string

/**
 * Selection key for a session row.
 * @param sessionId - the row's Session.
 * @returns the row's key in the shared account.
 */
export function sessionRowKey(sessionId: SessionId): RowKey {
  return `session:${sessionId}`
}

/**
 * Selection key for a Workspace (project) header row. The Ungrouped bucket has
 * no backing Workspace and no row verbs, so it never enters an account.
 * @param workspaceId - the row's Workspace.
 * @returns the row's key in the shared account.
 */
export function workspaceRowKey(workspaceId: WorkspaceId): RowKey {
  return `workspace:${workspaceId}`
}

/**
 * Whether a key addresses a Workspace (project) header row.
 * @param key - one row's key in the shared account.
 * @returns whether the key came from {@link workspaceRowKey}.
 */
export function isWorkspaceRowKey(key: RowKey): boolean {
  return key.startsWith('workspace:')
}

/**
 * The contiguous rendered slice between two rows, inclusive.
 * @param keys - every selectable row in rendered order.
 * @param from - one endpoint (the anchor).
 * @param to - the other endpoint (the row just clicked).
 * @returns the slice in rendered order, or nothing when an endpoint is no longer rendered.
 */
export function rowRange(keys: readonly RowKey[], from: RowKey, to: RowKey): readonly RowKey[] {
  const start = keys.indexOf(from)
  const end = keys.indexOf(to)
  if (start === -1 || end === -1) return []
  return start <= end ? keys.slice(start, end + 1) : keys.slice(end, start + 1)
}

/** One list's live multi-selection and the gestures that edit it. */
export interface RowSelection {
  /** Selected rows in rendered order; a row that stopped rendering has already left. */
  readonly keys: readonly RowKey[]
  /** Whether one row is in the selection. */
  readonly has: (key: RowKey) => boolean
  /** Plain activation: this row becomes the range anchor and the selection empties. */
  readonly anchorAt: (key: RowKey) => void
  /**
   * Shift activation: select every rendered row between the open range's anchor
   * and this one. With no range open yet the gesture's own origin becomes the
   * anchor — the row a shift-click landed on, or the row a Shift+arrow left.
   */
  readonly extendTo: (to: RowKey, origin: RowKey) => void
  /** Ctrl/Cmd activation: add or remove this row, which also becomes the anchor. */
  readonly toggle: (key: RowKey) => void
  /** Drop the selection — a bulk action committed, or Escape withdrew it. */
  readonly clear: () => void
}

/** Anchor plus raw membership; membership is reconciled against rendered rows on read. */
interface SelectionState {
  anchor: RowKey | undefined
  keys: readonly RowKey[]
}

const EMPTY: SelectionState = { anchor: undefined, keys: [] }

/**
 * Track a multi-selection over one list's rendered rows.
 * @param renderedKeys - every selectable row the list renders, in rendered order.
 * @returns the reconciled selection and its gestures.
 */
export function useRowSelection(renderedKeys: readonly RowKey[]): RowSelection {
  const [state, setState] = useState<SelectionState>(EMPTY)
  // Rendered order is the account: a row that was archived, filtered out by a
  // search, or folded away leaves the selection without a reconciliation pass.
  const keys = renderedKeys.filter(key => state.keys.includes(key))
  const active = keys.length > 0
  // Escape withdraws a selection from anywhere, not only from the row that
  // holds the list's tab seat: the gesture that made the selection was a
  // pointer press, which leaves focus wherever it already was.
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setState(EMPTY)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [active])
  return {
    keys,
    has: key => keys.includes(key),
    anchorAt: (key) => {
      // Every navigating click lands here, so an already-anchored row with
      // nothing selected writes no state and costs the list no render.
      if (state.anchor === key && state.keys.length === 0) return
      setState({ anchor: key, keys: [] })
    },
    extendTo: (to, origin) => {
      // An open range keeps its anchor across successive extends, so a run of
      // Shift+arrows grows from where the range began rather than from the row
      // each keystroke left.
      const anchor = state.anchor ?? origin
      setState({ anchor, keys: rowRange(renderedKeys, anchor, to) })
    },
    toggle: (key) => {
      setState({
        anchor: key,
        keys: keys.includes(key) ? keys.filter(selected => selected !== key) : [...keys, key],
      })
    },
    clear: () => { setState(EMPTY) },
  }
}
