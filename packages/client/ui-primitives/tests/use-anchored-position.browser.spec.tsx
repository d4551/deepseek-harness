import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useAnchoredPosition } from '../src/useAnchoredPosition.ts'
import css from '../src/Menu.module.css'

afterEach(cleanup)

function Host({ open, getAnchorRect, rows = 1 }: {
  open: boolean
  getAnchorRect?: () => DOMRect | null
  rows?: number
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, getAnchorRect, gap: 4, margin: 12 })
  return <>
    <button ref={anchorRef} type="button">Anchor</button>
    {open && <div ref={panelRef} data-testid="panel" className={`${css.list} ${css.portal}`}
      data-anchored-position={position ?? undefined} aria-hidden={position === null || undefined}>
      {Array.from({ length: rows }, (_, index) => <button type="button" key={index} className={css.item}>Action {index}</button>)}
    </div>}
  </>
}

describe('useAnchoredPosition', () => {
  it('owns and releases its stylesheet and listeners across close, reopen, and unmount', () => {
    const baseline = [...document.adoptedStyleSheets]
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const view = render(<Host open />)
    const panel = view.getByTestId('panel')
    expect(panel.hasAttribute('style')).toBe(false)
    expect(document.adoptedStyleSheets).toHaveLength(baseline.length + 1)
    const scroll = add.mock.calls.find(([type]) => type === 'scroll')
    const resize = add.mock.calls.find(([type]) => type === 'resize')
    expect(scroll).toBeDefined()
    expect(resize).toBeDefined()
    view.rerender(<Host open={false} />)
    expect(document.adoptedStyleSheets).toEqual(baseline)
    expect(remove.mock.calls).toContainEqual(scroll)
    expect(remove.mock.calls).toContainEqual(resize)
    view.rerender(<Host open />)
    expect(view.getByTestId('panel').getBoundingClientRect().top).toBe(view.getByRole('button', { name: 'Anchor' }).getBoundingClientRect().bottom + 4)
    expect(document.adoptedStyleSheets).toHaveLength(baseline.length + 1)
    view.unmount()
    expect(document.adoptedStyleSheets).toEqual(baseline)
    add.mockRestore()
    remove.mockRestore()
  })

  it('repositions when its actual content changes height and releases its observer on close', async () => {
    const observe = vi.spyOn(ResizeObserver.prototype, 'observe')
    const disconnect = vi.spyOn(ResizeObserver.prototype, 'disconnect')
    let rect = new DOMRect(40, window.innerHeight - 2, 32, 0)
    const getAnchorRect = () => rect
    const view = render(<Host open getAnchorRect={getAnchorRect} />)
    const panel = view.getByTestId('panel')
    const owner = observe.mock.contexts[observe.mock.calls.findIndex(([target]) => target === panel)]
    expect(owner).toBeInstanceOf(ResizeObserver)
    const before = panel.getBoundingClientRect()
    expect(before.bottom).toBe(window.innerHeight - 12)
    view.rerender(<Host open rows={3} getAnchorRect={getAnchorRect} />)
    await expect.poll(() => panel.getBoundingClientRect().bottom).toBe(window.innerHeight - 12)
    expect(panel.getBoundingClientRect().height).toBeGreaterThan(before.height)
    expect(panel.getBoundingClientRect().top).toBeLessThan(before.top)
    expect(panel.hasAttribute('style')).toBe(false)
    view.rerender(<Host open={false} getAnchorRect={getAnchorRect} />)
    expect(disconnect.mock.contexts).toContain(owner)
    rect = new DOMRect(80, 200, 32, 28)
    fireEvent.resize(window)
    expect(view.queryByTestId('panel')).toBeNull()
    observe.mockRestore()
    disconnect.mockRestore()
  })

  it('isolates simultaneous panels and preserves a concurrently adopted stylesheet on cleanup', () => {
    const baseline = [...document.adoptedStyleSheets]
    const first = render(<Host open getAnchorRect={() => new DOMRect(40, 100, 32, 28)} />)
    const second = render(<Host open getAnchorRect={() => new DOMRect(80, 200, 32, 28)} />)
    const panels = document.querySelectorAll<HTMLElement>('[data-testid="panel"]')
    const [one, two] = panels
    if (one === undefined || two === undefined) throw new Error('Both panels must be mounted')
    expect(one.getBoundingClientRect().left).toBe(40)
    expect(one.getBoundingClientRect().top).toBe(132)
    expect(two.getBoundingClientRect().left).toBe(80)
    expect(two.getBoundingClientRect().top).toBe(232)
    expect(one.dataset.anchoredPosition).not.toBe(two.dataset.anchoredPosition)
    const sibling = new CSSStyleSheet()
    sibling.replaceSync(':root { --position-test-owner: retained; }')
    document.adoptedStyleSheets.push(sibling)
    first.unmount()
    expect(document.adoptedStyleSheets).toHaveLength(baseline.length + 2)
    expect(two.getBoundingClientRect().left).toBe(80)
    second.unmount()
    expect(document.adoptedStyleSheets).toEqual([...baseline, sibling])
    document.adoptedStyleSheets = baseline
  })

  it('attaches no stylesheet or placement listeners while closed', () => {
    const baseline = [...document.adoptedStyleSheets]
    const add = vi.spyOn(window, 'addEventListener')
    render(<Host open={false} />)
    expect(document.adoptedStyleSheets).toEqual(baseline)
    expect(add.mock.calls.filter(([type]) => type === 'scroll' || type === 'resize')).toEqual([])
    add.mockRestore()
  })
})
