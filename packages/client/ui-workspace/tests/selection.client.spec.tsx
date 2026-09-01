// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isHeaderRowKey, overflowRowKey, rowRange, sessionRowKey, UNGROUPED_ROW_KEY, useRowSelection, workspaceRowKey } from '../src/client/selection.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const ids = (...values: string[]) => values.map(sid)

/** Minimal list harness: one button per row plus a read-out of the live selection. */
function Harness({ rows, onRender, outsider }: {
  rows: readonly string[]
  onRender?: () => void
  /** A key the account never holds, reached from the last rendered row. */
  outsider?: string
}) {
  const selection = useRowSelection(rows)
  onRender?.()
  return (
    <div>
      <span data-testid="selected">{selection.keys.join(',')}</span>
      {outsider !== undefined && (
        <button
          type="button"
          onClick={() => { selection.extendTo(outsider, rows[rows.length - 1]!) }}
        >
          {outsider}
        </button>
      )}
      {rows.map(row => (
        <button
          key={row}
          type="button"
          aria-pressed={selection.has(row)}
          onClick={(event) => {
            if (event.shiftKey) selection.extendTo(row, row)
            else if (event.ctrlKey) selection.toggle(row)
            else selection.anchorAt(row)
          }}
        >
          {row}
        </button>
      ))}
      <button type="button" onClick={selection.clear}>clear</button>
      <button type="button" onClick={selection.selectAll}>all</button>
    </div>
  )
}

const selected = () => screen.getByTestId('selected').textContent
const row = (id: string) => screen.getByRole('button', { name: id })

describe('rowRange', () => {
  it('reads a slice in rendered order from either endpoint', () => {
    const rows = ids('a', 'b', 'c', 'd')
    expect(rowRange(rows, 'b', 'd')).toEqual(ids('b', 'c', 'd'))
    expect(rowRange(rows, 'd', 'b')).toEqual(ids('b', 'c', 'd'))
    expect(rowRange(rows, 'c', 'c')).toEqual(ids('c'))
  })

  it('selects nothing when either endpoint is no longer rendered', () => {
    const rows = ids('a', 'b')
    expect(rowRange(rows, 'gone', 'b')).toEqual([])
    expect(rowRange(rows, 'a', 'gone')).toEqual([])
  })
})

describe('row keys', () => {
  it('reads back the kind that produced a key, so a leaf can find its header', () => {
    expect(isHeaderRowKey(workspaceRowKey(wid('x')))).toBe(true)
    expect(isHeaderRowKey(UNGROUPED_ROW_KEY)).toBe(true)
    expect(isHeaderRowKey(sessionRowKey(sid('x')))).toBe(false)
    // An overflow row sits under a header rather than heading anything, so a
    // leaf's step to its parent walks past it.
    expect(isHeaderRowKey(overflowRowKey('x'))).toBe(false)
  })

  it('separates the row kinds so an id collision cannot cross them', () => {
    expect(new Set([sessionRowKey(sid('x')), workspaceRowKey(wid('x')), overflowRowKey('x')]).size).toBe(3)
    expect(sessionRowKey(sid('x'))).toBe('session:x')
    expect(workspaceRowKey(wid('x'))).toBe('workspace:x')
    expect(overflowRowKey('x')).toBe('overflow:x')
  })

  it('takes every rendered row and anchors at the head', () => {
    const rows = ['a', 'b', 'c']
    render(<Harness rows={rows} />)
    fireEvent.click(row('b'))
    fireEvent.click(row('all'))
    expect(selected()).toBe('a,b,c')
    // Anchored at the head, so a Shift move narrows the range from there.
    fireEvent.click(row('b'), { shiftKey: true })
    expect(selected()).toBe('a,b')
  })

  it('spans both kinds in one rendered account', () => {
    const account = [workspaceRowKey(wid('alpha')), sessionRowKey(sid('a1')), workspaceRowKey(wid('beta'))]
    expect(rowRange(account, workspaceRowKey(wid('alpha')), workspaceRowKey(wid('beta')))).toEqual(account)
  })
})

describe('useRowSelection', () => {
  it('extends from the last plainly activated row and drops it again on the next plain activation', () => {
    render(<Harness rows={ids('a', 'b', 'c', 'd')} />)
    fireEvent.click(row('b'))
    expect(selected()).toBe('')
    fireEvent.click(row('d'), { shiftKey: true })
    expect(selected()).toBe('b,c,d')
    expect(row('c').getAttribute('aria-pressed')).toBe('true')
    expect(row('a').getAttribute('aria-pressed')).toBe('false')

    // Re-extending replaces the range rather than accumulating it.
    fireEvent.click(row('c'), { shiftKey: true })
    expect(selected()).toBe('b,c')
    fireEvent.click(row('a'))
    expect(selected()).toBe('')
  })

  it('re-anchors the same row without writing state again', () => {
    let renders = 0
    render(<Harness rows={ids('a', 'b')} onRender={() => { renders += 1 }} />)
    fireEvent.click(row('a'))
    const settled = renders
    // The common navigating click re-anchors the row it already anchored.
    fireEvent.click(row('a'))
    expect(renders).toBe(settled)
    fireEvent.click(row('b'))
    expect(renders).toBeGreaterThan(settled)
  })

  it('anchors a shift activation on itself when nothing was activated first', () => {
    render(<Harness rows={ids('a', 'b', 'c')} />)
    fireEvent.click(row('b'), { shiftKey: true })
    expect(selected()).toBe('b')
    fireEvent.click(row('c'), { shiftKey: true })
    expect(selected()).toBe('b,c')
  })

  it('adds and removes single rows without disturbing rendered order', () => {
    render(<Harness rows={ids('a', 'b', 'c')} />)
    fireEvent.click(row('c'), { ctrlKey: true })
    fireEvent.click(row('a'), { ctrlKey: true })
    expect(selected()).toBe('a,c')
    fireEvent.click(row('c'), { ctrlKey: true })
    expect(selected()).toBe('a')
  })

  it('holds an open range when a shift reaches a row the account does not hold', () => {
    // The ungrouped header and a blank draft render between selectable rows but
    // carry no verbs, so a Shift+arrow can land on one. Reaching past the last
    // selectable row must not empty the range the operator already built.
    render(<Harness rows={ids('a', 'b', 'c')} outsider="ungrouped" />)
    fireEvent.click(row('a'))
    fireEvent.click(row('c'), { shiftKey: true })
    expect(selected()).toBe('a,b,c')

    fireEvent.click(row('ungrouped'))
    expect(selected()).toBe('a,b,c')
  })

  it('restarts the range from the gesture when the anchor stopped rendering', () => {
    // Archiving the anchored row retires it from the account. A later shift
    // must not resolve against the row that left, which would select nothing
    // and keep doing so for every shift after it.
    const view = render(<Harness rows={ids('a', 'b', 'c')} />)
    fireEvent.click(row('a'))
    view.rerender(<Harness rows={ids('b', 'c')} />)

    fireEvent.click(row('c'), { shiftKey: true })
    expect(selected()).toBe('c')
    fireEvent.click(row('b'), { shiftKey: true })
    expect(selected()).toBe('b,c')
  })

  it('drops rows that stopped rendering and clears on Escape or an explicit clear', () => {
    const view = render(<Harness rows={ids('a', 'b', 'c')} />)
    fireEvent.click(row('a'))
    fireEvent.click(row('c'), { shiftKey: true })
    expect(selected()).toBe('a,b,c')

    view.rerender(<Harness rows={ids('a', 'c')} />)
    expect(selected()).toBe('a,c')

    // Only Escape withdraws the selection from the document listener.
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(selected()).toBe('a,c')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(selected()).toBe('')

    // A withdrawn selection also drops the anchor: the next shift is its own.
    fireEvent.click(row('c'), { shiftKey: true })
    expect(selected()).toBe('c')
    fireEvent.click(screen.getByRole('button', { name: 'clear' }))
    expect(selected()).toBe('')
  })
})
