// @vitest-environment jsdom
/**
 * Roving tab seat: one tab stop per list, arrow moves that clamp at both ends,
 * and the step out to a Workspace header a session row sits under.
 */
import { useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRowFocus } from '../src/client/row-focus.ts'
import type { FocusTarget } from '../src/client/row-focus.ts'
import type { RowKey } from '../src/client/selection.ts'

afterEach(cleanup)

/**
 * Minimal list harness: one focusable row per key, a read-out of the seat, and
 * a landing read-out so a move that the edge absorbed is distinguishable from
 * one that travelled.
 */
function Harness({ rows, target }: { rows: readonly RowKey[]; target: FocusTarget }) {
  const listRef = useRef<HTMLDivElement>(null)
  const focus = useRowFocus(rows, listRef)
  return (
    <div ref={listRef}>
      <span data-testid="seat">{focus.seat}</span>
      {rows.map(row => (
        <button
          key={row}
          type="button"
          data-row-key={row}
          tabIndex={focus.seat === row ? 0 : -1}
          onClick={() => {
            const landed = focus.moveFrom(row, target)
            screen.getByTestId('landed').textContent = landed ?? 'held'
          }}
        >
          {row}
        </button>
      ))}
      <span data-testid="landed" />
    </div>
  )
}

const seat = () => screen.getByTestId('seat').textContent
const landed = () => screen.getByTestId('landed').textContent
const row = (id: string) => screen.getByRole('button', { name: id })

describe('useRowFocus', () => {
  it('seats the head of the account until a move asks for another row', () => {
    render(<Harness rows={['a', 'b', 'c']} target="next" />)
    expect(seat()).toBe('a')
    expect(row('a').tabIndex).toBe(0)
    expect(row('b').tabIndex).toBe(-1)
    fireEvent.click(row('a'))
    expect(seat()).toBe('b')
    expect(landed()).toBe('b')
    expect(row('b').tabIndex).toBe(0)
    expect(document.activeElement).toBe(row('b'))
  })

  it('holds at the end of the account instead of wrapping', () => {
    render(<Harness rows={['a', 'b']} target="next" />)
    fireEvent.click(row('b'))
    expect(seat()).toBe('a')
    expect(landed()).toBe('held')
  })

  it('holds at the head on a move back from the first row', () => {
    render(<Harness rows={['a', 'b']} target="previous" />)
    fireEvent.click(row('a'))
    expect(landed()).toBe('held')
    fireEvent.click(row('b'))
    expect(seat()).toBe('a')
    expect(document.activeElement).toBe(row('a'))
  })

  it('jumps to either end of the account', () => {
    const { rerender } = render(<Harness rows={['a', 'b', 'c']} target="last" />)
    fireEvent.click(row('a'))
    expect(seat()).toBe('c')
    rerender(<Harness rows={['a', 'b', 'c']} target="first" />)
    fireEvent.click(row('c'))
    expect(seat()).toBe('a')
  })

  it('steps out to the header a session row sits under', () => {
    render(<Harness rows={['workspace:one', 'session:a', 'session:b']} target="parent" />)
    fireEvent.click(row('session:b'))
    expect(seat()).toBe('workspace:one')
    expect(document.activeElement).toBe(row('workspace:one'))
  })

  it('holds where no header precedes the row, as in the flat list', () => {
    render(<Harness rows={['session:a', 'session:b']} target="parent" />)
    fireEvent.click(row('session:b'))
    expect(landed()).toBe('held')
    expect(seat()).toBe('session:a')
  })

  it('falls back to the head when the seated row stops rendering', () => {
    const { rerender } = render(<Harness rows={['a', 'b', 'c']} target="next" />)
    fireEvent.click(row('a'))
    expect(seat()).toBe('b')
    rerender(<Harness rows={['a', 'c']} target="next" />)
    expect(seat()).toBe('a')
  })

  it('seats nothing while the account is empty', () => {
    render(<Harness rows={[]} target="next" />)
    expect(seat()).toBe('')
  })
})
