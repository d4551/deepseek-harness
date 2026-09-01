// @vitest-environment jsdom
/**
 * Roving tab seat: one tab stop per list, arrow moves that clamp at both ends,
 * and the step out to a Workspace header a session row sits under.
 */
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TYPE_AHEAD_MS, useRowFocus } from '../src/client/row-focus.ts'
import type { FocusTarget } from '../src/client/row-focus.ts'
import type { RowKey } from '../src/client/selection.ts'

afterEach(cleanup)

/**
 * Minimal list harness: one focusable row per key, a read-out of the seat, and
 * a landing read-out so a move that the edge absorbed is distinguishable from
 * one that travelled.
 */
function Harness(
  { rows, target, outside = false, labels = {} }:
  {
    rows: readonly RowKey[]
    target: FocusTarget
    outside?: boolean
    /** Type-ahead labels by row key; a row without one is labelled by its key. */
    labels?: Readonly<Record<string, string>>
  },
) {
  const listRef = useRef<HTMLDivElement>(null)
  const focus = useRowFocus(rows, listRef)
  return (
    <>
      {outside ? <button type="button">outside</button> : null}
      <div ref={listRef}>
        <span data-testid="seat">{focus.seat}</span>
        {rows.map(row => (
          <button
            key={row}
            type="button"
            data-row-key={row}
            data-row-label={labels[row] ?? row}
            tabIndex={focus.seat === row ? 0 : -1}
            onClick={() => {
              const landed = focus.moveFrom(row, target)
              screen.getByTestId('landed').textContent = landed ?? 'held'
            }}
            onKeyDown={(event) => {
              const landed = focus.typeAheadFrom(row, event.key)
              screen.getByTestId('landed').textContent = landed ?? 'held'
            }}
          >
            {row}
          </button>
        ))}
        <span data-testid="landed" />
      </div>
    </>
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

  it('gives the focus back to the list when the row holding it stops rendering', () => {
    const { rerender } = render(<Harness rows={['a', 'b', 'c']} target="next" />)
    fireEvent.click(row('a'))
    expect(document.activeElement).toBe(row('b'))
    rerender(<Harness rows={['a', 'c']} target="next" />)
    expect(document.activeElement).toBe(row('a'))
  })

  it('recovers a focus the seat never moved to, when that row is the one that leaves', () => {
    // The operator can put the focus on a row the arrows never visited, and
    // the seat that reconciles is then unchanged when that row is archived.
    const { rerender } = render(<Harness rows={['a', 'b', 'c']} target="next" />)
    row('c').focus()
    expect(seat()).toBe('a')
    rerender(<Harness rows={['a', 'b']} target="next" />)
    expect(seat()).toBe('a')
    expect(document.activeElement).toBe(row('a'))
  })

  it('gives the recovery up once the operator drops the focus on purpose', () => {
    // Blurring a row leaves it in the document, which is what tells this list
    // the focus is no longer its to recover.
    const { rerender } = render(<Harness rows={['a', 'b', 'c']} target="next" />)
    row('c').focus()
    row('c').blur()
    rerender(<Harness rows={['a', 'b']} target="next" />)
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves a focus that moved out of the list alone, however long ago it drove one', () => {
    // The operator left for another control, and that control is what went
    // away; the seat this list reconciles is no answer to where they were.
    const { rerender } = render(<Harness rows={['a', 'b', 'c']} target="next" outside />)
    fireEvent.click(row('a'))
    screen.getByRole('button', { name: 'outside' }).focus()
    rerender(<Harness rows={['a', 'c']} target="next" />)
    expect(document.activeElement).toBe(document.body)
  })

  describe('type-ahead', () => {
    const fruit = ['a', 'b', 'c'] as const
    const labels = { a: 'Alpha', b: 'Apple', c: 'Cherry' }

    afterEach(() => { vi.useRealTimers() })

    it('lands on the next row whose label starts with the character', () => {
      vi.useFakeTimers()
      render(<Harness rows={fruit} target="next" labels={labels} />)
      fireEvent.keyDown(row('a'), { key: 'c' })
      expect(seat()).toBe('c')
      expect(document.activeElement).toBe(row('c'))
    })

    it('walks the rows starting with one character as it is repeated', () => {
      vi.useFakeTimers()
      render(<Harness rows={fruit} target="next" labels={labels} />)
      fireEvent.keyDown(row('a'), { key: 'a' })
      expect(seat()).toBe('b')
      fireEvent.keyDown(row('b'), { key: 'a' })
      expect(seat()).toBe('a')
    })

    it('refines the row it found as the buffer grows', () => {
      vi.useFakeTimers()
      render(<Harness rows={fruit} target="next" labels={labels} />)
      fireEvent.keyDown(row('a'), { key: 'a' })
      expect(seat()).toBe('b')
      fireEvent.keyDown(row('b'), { key: 'p' })
      expect(seat()).toBe('b')
      expect(landed()).toBe('held')

      // A buffer that has stopped being one repeated character stays a prefix.
      fireEvent.keyDown(row('b'), { key: 'p' })
      expect(seat()).toBe('b')
      fireEvent.keyDown(row('b'), { key: 'z' })
      expect(seat()).toBe('b')
      expect(landed()).toBe('held')
    })

    it('starts a fresh search once the buffer window has passed', () => {
      vi.useFakeTimers()
      render(<Harness rows={fruit} target="next" labels={labels} />)
      fireEvent.keyDown(row('a'), { key: 'c' })
      expect(seat()).toBe('c')
      vi.advanceTimersByTime(TYPE_AHEAD_MS + 1)
      fireEvent.keyDown(row('c'), { key: 'a' })
      expect(seat()).toBe('a')
    })

    it('holds where no label starts with what was typed', () => {
      vi.useFakeTimers()
      render(<Harness rows={fruit} target="next" labels={labels} />)
      fireEvent.keyDown(row('a'), { key: 'z' })
      expect(seat()).toBe('a')
      expect(landed()).toBe('held')
    })
  })

  it('seats nothing while the account is empty', () => {
    render(<Harness rows={[]} target="next" />)
    expect(seat()).toBe('')
  })
})
