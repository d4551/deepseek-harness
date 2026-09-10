import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { POINTER_GRACE_MS } from '../src/pointer-grace.ts'
import './tooltip-layout.css'

beforeEach(async () => { await page.viewport(1024, 768) })
afterEach(() => { cleanup(); vi.useRealTimers() })

function fitsViewport() {
  const bubble = screen.getByRole('tooltip')
  const bounds = bubble.getBoundingClientRect()
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth)
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight)
  expect(bubble.hasAttribute('style')).toBe(false)
  return bounds
}

describe('Tooltip', () => {
  it('resolves lazy labels only after the bubble becomes visible', () => {
    vi.useFakeTimers()
    const label = vi.fn(() => 'Timing details')
    render(<Tooltip label={label} delayMs={500}><button type="button">anchor</button></Tooltip>)
    expect(label).not.toHaveBeenCalled()
    fireEvent.mouseEnter(screen.getByText('anchor'))
    act(() => { vi.advanceTimersByTime(499) })
    expect(label).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('tooltip').textContent).toBe('Timing details')
    expect(label).toHaveBeenCalledOnce()
  })

  it('can delay pointer hover without delaying keyboard focus', () => {
    vi.useFakeTimers()
    render(<Tooltip label="Timing details" delayMs={500}><button type="button">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    act(() => { vi.advanceTimersByTime(499) })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseLeave(anchor)
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(anchor)
    act(() => { vi.advanceTimersByTime(500) })
    expect(screen.getByRole('tooltip').textContent).toBe('Timing details')
    fireEvent.mouseLeave(anchor)
    fireEvent.focus(anchor)
    expect(screen.getByRole('tooltip').textContent).toBe('Timing details')
  })

  it('shows the bubble to the right on hover and hides it on leave', () => {
    vi.useFakeTimers()
    render(<Tooltip label="Open sidebar"><button type="button" className="tooltip-test-center">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    expect(screen.getByRole('tooltip').textContent).toBe('Open sidebar')
    expect(fitsViewport().left).toBeGreaterThan(anchor.getBoundingClientRect().right)
    fireEvent.mouseLeave(anchor)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('supports bottom placement and the focus/blur channel', () => {
    render(<Tooltip label="Below" side="bottom"><button type="button" className="tooltip-test-center">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.focus(anchor)
    expect(fitsViewport().top).toBeGreaterThan(anchor.getBoundingClientRect().bottom)
    fireEvent.blur(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('caps a long description to its control width', () => {
    render(<Tooltip label={'A description long enough to need a cap. '.repeat(8)} side="bottom" constrainToAnchor><button type="button" className="tooltip-test-center">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    expect(Number.parseFloat(getComputedStyle(screen.getByRole('tooltip')).maxWidth)).toBe(anchor.getBoundingClientRect().width)
    fitsViewport()
  })

  it('keeps a bubble near the right viewport edge inside', () => {
    render(<Tooltip label="A wide description next to the viewport edge" side="bottom"><button type="button" className="tooltip-test-right">anchor</button></Tooltip>)
    fireEvent.mouseEnter(screen.getByText('anchor'))
    fitsViewport()
  })

  it('repositions after label and viewport width changes', async () => {
    const view = render(<Tooltip label={'Wide description '.repeat(8)} side="bottom"><button type="button" className="tooltip-test-right">anchor</button></Tooltip>)
    fireEvent.mouseEnter(screen.getByText('anchor'))
    const wide = fitsViewport().width
    view.rerender(<Tooltip label="Short" side="bottom"><button type="button" className="tooltip-test-right">anchor</button></Tooltip>)
    expect(fitsViewport().width).toBeLessThan(wide)
    await page.viewport(390, 844)
    fitsViewport()
  })

  it('keeps a bubble near the left viewport edge inside', () => {
    render(<Tooltip label="A wide description next to the viewport edge" side="bottom"><button type="button" className="tooltip-test-left">anchor</button></Tooltip>)
    fireEvent.mouseEnter(screen.getByText('anchor'))
    fitsViewport()
  })

  it('supports top placement for anchors at the viewport bottom', () => {
    render(<Tooltip label="Above" side="top"><button type="button" className="tooltip-test-bottom">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    expect(fitsViewport().bottom).toBeLessThan(anchor.getBoundingClientRect().top)
  })

  it('flips a bottom bubble above an anchor with no room below', () => {
    render(<Tooltip label="Tall description" side="bottom"><button type="button" className="tooltip-test-bottom">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    expect(fitsViewport().bottom).toBeLessThan(anchor.getBoundingClientRect().top)
  })

  it('flips a top bubble below an anchor with no room above', () => {
    render(<Tooltip label="Tall description" side="top"><button type="button" className="tooltip-test-top">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    expect(fitsViewport().top).toBeGreaterThan(anchor.getBoundingClientRect().bottom)
  })

  it('aligns an oversized description to the viewport without clipping its text', () => {
    render(<Tooltip label={'A long description.\n'.repeat(100)} side="bottom"><button type="button" className="tooltip-test-center">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    const bubble = screen.getByRole('tooltip')
    expect(bubble.getBoundingClientRect().height).toBeGreaterThan(window.innerHeight)
    expect(bubble.getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
    expect(bubble.getBoundingClientRect().top).toBeLessThan(anchor.getBoundingClientRect().bottom)
    expect(bubble.scrollHeight).toBe(bubble.clientHeight)
  })

  it('chains the anchor handlers', () => {
    const onMouseEnter = vi.fn()
    const onMouseLeave = vi.fn()
    const onFocus = vi.fn()
    const onBlur = vi.fn()
    render(<Tooltip label="Chained"><button type="button" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onFocus={onFocus} onBlur={onBlur}>anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    fireEvent.mouseLeave(anchor)
    fireEvent.focus(anchor)
    fireEvent.blur(anchor)
    expect(onMouseEnter).toHaveBeenCalledOnce()
    expect(onMouseLeave).toHaveBeenCalledOnce()
    expect(onFocus).toHaveBeenCalledOnce()
    expect(onBlur).toHaveBeenCalledOnce()
  })

  it('retains the anchor when availability changes', () => {
    const view = render(<Tooltip label="Rail" disabled><button type="button">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.mouseEnter(anchor)
    expect(screen.queryByRole('tooltip')).toBeNull()
    view.rerender(<Tooltip label="Rail"><button type="button">anchor</button></Tooltip>)
    expect(screen.getByText('anchor')).toBe(anchor)
    fireEvent.mouseEnter(anchor)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })

  it('keeps the description while focused or hovered and permits crossing into it', () => {
    vi.useFakeTimers()
    render(<Tooltip label="Sticky"><button type="button">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.focus(anchor)
    fireEvent.mouseEnter(anchor)
    fireEvent.mouseLeave(anchor)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.mouseEnter(screen.getByRole('tooltip'))
    fireEvent.blur(anchor)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.mouseLeave(screen.getByRole('tooltip'))
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS - 1) })
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.mouseEnter(anchor)
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.mouseLeave(anchor)
    act(() => { vi.advanceTimersByTime(POINTER_GRACE_MS) })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('preserves object and callback refs', () => {
    const objectRef: { current: HTMLButtonElement | null } = { current: null }
    const callbackRef = vi.fn()
    const view = render(<Tooltip label="Add"><button type="button" ref={objectRef}>anchor</button></Tooltip>)
    expect(objectRef.current).toBe(screen.getByText('anchor'))
    fireEvent.mouseEnter(screen.getByText('anchor'))
    expect(screen.getByRole('tooltip')).toBeTruthy()
    view.rerender(<Tooltip label="Add"><button type="button" ref={callbackRef}>anchor</button></Tooltip>)
    expect(callbackRef).toHaveBeenCalledWith(screen.getByText('anchor'))
  })

  it('drops a visible bubble when disabled changes mid-hover', () => {
    const view = render(<Tooltip label="Rail"><button type="button">anchor</button></Tooltip>)
    fireEvent.mouseEnter(screen.getByText('anchor'))
    expect(screen.getByRole('tooltip')).toBeTruthy()
    view.rerender(<Tooltip label="Rail" disabled><button type="button">anchor</button></Tooltip>)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('associates the description and dismisses it with Escape', () => {
    render(<Tooltip label="Extra description"><button type="button" aria-describedby="existing">anchor</button></Tooltip>)
    const anchor = screen.getByText('anchor')
    fireEvent.focus(anchor)
    expect(anchor.getAttribute('aria-describedby')).toBe(`existing ${screen.getByRole('tooltip').id}`)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(anchor.getAttribute('aria-describedby')).toBe('existing')
  })
})
