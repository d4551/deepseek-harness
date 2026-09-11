import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useState, type ComponentProps } from 'react'
import { Menu } from '../src/Menu.tsx'
import './menu-position.browser.css'

afterEach(cleanup)

type Placement = Pick<ComponentProps<typeof Menu>, 'getAnchorRect' | 'side' | 'align' | 'closeOnPointerLeave'>

function PositionedMenu({ extraItems = 0, ...props }: Placement & { extraItems?: number }) {
  const [open, setOpen] = useState(true)
  const [selected, setSelected] = useState('None')
  return <main>
    <Menu
      {...props}
      open={open}
      portal
      ariaLabel="Actions"
      anchor={<button type="button" onClick={() => { setOpen(showing => !showing) }}>Actions</button>}
      items={[{ id: 'rename', label: 'Rename' }, { id: 'archive', label: 'Archive' },
        ...Array.from({ length: extraItems }, (_, index) => ({ id: `action-${index}`, label: `Action ${index}` }))]}
      onSelect={(id) => { setSelected(id); setOpen(false) }}
      onClose={() => { setOpen(false) }}
    />
    <output aria-label="Selection">{selected}</output>
  </main>
}

describe('Menu placement', () => {
  it.each<Required<Pick<Placement, 'side' | 'align'>>>([
    { side: 'bottom', align: 'start' },
    { side: 'bottom', align: 'end' },
    { side: 'top', align: 'start' },
    { side: 'top', align: 'end' },
    { side: 'right', align: 'start' },
  ])('places $side/$align against its requested rectangle', ({ side, align }) => {
    const rect = new DOMRect(align === 'end' ? 280 : 30, 240, 40, 32)
    render(<PositionedMenu side={side} align={align} getAnchorRect={() => rect} />)
    const menu = screen.getByRole('menu', { name: 'Actions' })
    const bounds = menu.getBoundingClientRect()
    expect(menu.hasAttribute('style')).toBe(false)
    expect(menu.parentElement).toBe(screen.getByRole('main'))
    if (side === 'right') {
      expect(bounds.left).toBe(rect.right + 4)
      expect(bounds.top).toBe(rect.top)
    } else {
      expect(align === 'start' ? bounds.left : bounds.right).toBe(align === 'start' ? rect.left : rect.right)
      expect(side === 'top' ? bounds.bottom : bounds.top).toBe(side === 'top' ? rect.top - 4 : rect.bottom + 4)
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.getByLabelText('Selection').textContent).toBe('rename')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('follows scroll and resize and hides while its external anchor is unavailable', () => {
    let rect: DOMRect | null = new DOMRect(40, 100, 32, 28)
    render(<PositionedMenu getAnchorRect={() => rect} />)
    const menu = screen.getByRole('menu')
    expect(menu.getBoundingClientRect().left).toBe(40)
    expect(menu.getBoundingClientRect().top).toBe(132)
    rect = new DOMRect(80, 200, 32, 28)
    fireEvent.scroll(screen.getByRole('main'))
    expect(menu.getBoundingClientRect().left).toBe(80)
    expect(menu.getBoundingClientRect().top).toBe(232)
    rect = null
    fireEvent.resize(window)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(menu.inert).toBe(true)
    rect = new DOMRect(120, 140, 32, 28)
    fireEvent.resize(window)
    expect(screen.getByRole('menu')).toBe(menu)
    expect(menu.getBoundingClientRect().left).toBe(120)
    expect(menu.getBoundingClientRect().top).toBe(172)
    expect(menu.inert).toBe(false)
  })

  it.each<Required<Pick<Placement, 'side'>>>([
    { side: 'bottom' },
    { side: 'right' },
  ])('flips a $side menu before it can cover an edge-adjacent trigger', ({ side }) => {
    render(<PositionedMenu side={side} />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    const anchor = trigger.parentElement
    if (anchor === null) throw new Error('Menu trigger has no anchor')
    anchor.classList.add('menu-position-edge-anchor')
    fireEvent.resize(window)
    const menu = screen.getByRole('menu')
    const bounds = menu.getBoundingClientRect()
    expect(menu.hasAttribute('style')).toBe(false)
    const origin = anchor.getBoundingClientRect()
    if (side === 'bottom') expect(bounds.bottom).toBe(origin.top - 4)
    else expect(bounds.right).toBe(origin.left - 4)
    expect(bounds.left).toBeGreaterThanOrEqual(12)
    expect(bounds.top).toBeGreaterThanOrEqual(12)
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 12)
    expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 12)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByLabelText('Selection').textContent).toBe('None')
  })

  it('keeps viewport margins and tracks the panel after it mounts inside its landmark', async () => {
    const rect = new DOMRect(window.innerWidth - 2, window.innerHeight - 2, 0, 0)
    const getAnchorRect = () => rect
    const view = render(<PositionedMenu getAnchorRect={getAnchorRect} />)
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(screen.getByRole('main'))
    const before = menu.getBoundingClientRect()
    expect(before.right).toBe(window.innerWidth - 12)
    expect(before.bottom).toBe(window.innerHeight - 12)
    const itemHeight = screen.getByRole('menuitem', { name: 'Rename' }).getBoundingClientRect().height
    view.rerender(<PositionedMenu extraItems={2} getAnchorRect={getAnchorRect} />)
    await expect.poll(() => menu.getBoundingClientRect().height).toBe(before.height + 2 * itemHeight)
    await expect.poll(() => menu.getBoundingClientRect().bottom).toBe(window.innerHeight - 12)
    expect(menu.getBoundingClientRect().top).toBe(before.top - 2 * itemHeight)
    expect(menu.hasAttribute('style')).toBe(false)
  })

  it('cancels a pending pointer dismissal when the menu becomes persistent', async () => {
    const view = render(<PositionedMenu closeOnPointerLeave />)
    const trigger = screen.getByRole('button', { name: 'Actions' })
    if (trigger.parentElement === null) throw new Error('Menu trigger has no parent')
    fireEvent.pointerLeave(trigger.parentElement)
    view.rerender(<PositionedMenu closeOnPointerLeave={false} />)
    await new Promise((resolve) => { window.setTimeout(resolve, 300) })
    expect(screen.getByRole('menu')).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
