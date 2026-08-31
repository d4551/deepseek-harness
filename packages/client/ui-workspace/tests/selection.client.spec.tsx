// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isHeaderRowKey, rowRange, sessionRowKey, UNGROUPED_ROW_KEY, useRowSelection, workspaceRowKey } from '../src/client/selection.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const ids = (...values: string[]) => values.map(sid)

/** Minimal list harness: one button per row plus a read-out of the live selection. */
function Harness({ rows, onRender }: { rows: readonly string[]; onRender?: () => void }) {
  const selection = useRowSelection(rows)
  onRender?.()
  return (
    <div>
      <span data-testid="selected">{selection.keys.join(',')}</span>
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
  })

  it('separates the two row kinds so an id collision cannot cross them', () => {
    expect(sessionRowKey(sid('x'))).not.toBe(workspaceRowKey(wid('x')))
    expect(sessionRowKey(sid('x'))).toBe('session:x')
    expect(workspaceRowKey(wid('x'))).toBe('workspace:x')
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
