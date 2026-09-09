import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('StateDot', () => {
  it.each(['done', 'warning', 'ongoing', 'error', 'inactive'] as const)('renders state %s as data-state', (state) => {
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
    // Chase phase: every cell carries its own negative animation delay.
    const delays = [...cells].map(cell => getComputedStyle(cell).animationDelay)
    expect(new Set(delays).size).toBe(8)
  })

  it('sizes via the size prop in both shapes', () => {
    const { container, rerender } = render(<StateDot state="done" size={12} />)
    const dot = container.firstElementChild as HTMLElement
    expect(getComputedStyle(dot).width).toBe('12px')
    expect(getComputedStyle(dot).height).toBe('12px')
    rerender(<StateDot state="ongoing" size={12} />)
    const ring = container.firstElementChild as SVGSVGElement
    expect(ring.getAttribute('width')).toBe('12')
    expect(ring.getAttribute('height')).toBe('12')
  })

  it('rejects unknown states at the type level', () => {
    expectTypeOf<Extract<StateDotState, 'paused'>>().toEqualTypeOf<never>()
  })
})
