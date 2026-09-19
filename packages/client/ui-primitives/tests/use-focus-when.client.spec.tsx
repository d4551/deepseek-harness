// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useFocusWhen } from '../src/useFocusWhen.ts'

afterEach(cleanup)

function FocusField({ active }: { active: boolean }) {
  const ref = useFocusWhen<HTMLInputElement>(active)
  return <input ref={ref} aria-label="objective" />
}

describe('useFocusWhen', () => {
  it('focuses the mounted control when active becomes true', () => {
    const { rerender } = render(<FocusField active={false} />)
    expect(document.activeElement).not.toBe(screen.getByLabelText('objective'))
    rerender(<FocusField active />)
    expect(document.activeElement).toBe(screen.getByLabelText('objective'))
  })

  it('refuses to claim focus when the target is not mounted', () => {
    function Missing() {
      useFocusWhen<HTMLInputElement>(true)
      return null
    }
    expect(() => render(<Missing />)).toThrow('focus target is not mounted')
  })
})
