// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('StateDot', () => {
  it.each(['done', 'warning', 'ongoing', 'error'] as const)('renders state %s as data-state', (state) => {
    const { container } = render(<StateDot state={state} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.dataset['state']).toBe(state)
    expect(dot.getAttribute('aria-hidden')).toBe('true')
  })

  it('solid states are spans; ongoing is an svg pixel matrix', () => {
    const { container, rerender } = render(<StateDot state="done" />)
    expect(container.firstElementChild?.tagName).toBe('SPAN')
    rerender(<StateDot state="ongoing" />)
    const matrix = container.firstElementChild as SVGSVGElement
    expect(matrix.tagName).toBe('svg')
    const cells = matrix.querySelectorAll('rect')
    expect(cells).toHaveLength(8)
    // Chase phase: every cell carries its own negative delay. The delay is
    // declared in the sheet and the phase crosses as a custom property, so the
    // value the component decides is read where it puts it.
    const delays = [...cells].map(cell => cell.style.getPropertyValue('--dsh-state-cell-delay'))
    expect(new Set(delays).size).toBe(8)
    expect(delays.every(delay => delay.endsWith('ms'))).toBe(true)
  })

  it('sizes via the size prop in both shapes', () => {
    const { container, rerender } = render(<StateDot state="done" size={12} />)
    const dot = container.firstElementChild as HTMLElement
    // One property, because the sheet spends it on both axes: a square dot is
    // the sheet's decision and the caller supplies only the number.
    expect(dot.style.getPropertyValue('--dsh-state-dot-size')).toBe('12px')
    rerender(<StateDot state="ongoing" size={12} />)
    const ring = container.firstElementChild as SVGSVGElement
    expect(ring.getAttribute('width')).toBe('12')
    expect(ring.getAttribute('height')).toBe('12')
  })

  it('rejects unknown states at the type level', () => {
    const bad = (state: StateDotState) => state
    // @ts-expect-error 'paused' is not one of the four states
    expect(bad('paused')).toBe('paused')
  })
})
