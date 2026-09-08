import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { Menu } from '../src/Menu.tsx'

afterEach(cleanup)

it('keeps arrows inside each menu and returns from the submenu without closing its parent', async () => {
  const close = vi.fn()
  const select = vi.fn()
  render(<main><Menu
    open
    ariaLabel="Actions"
    anchor={<button type="button">Actions</button>}
    items={[
      { id: 'create', label: 'Create', submenu: [
        { id: 'file', label: 'File' },
        { id: 'folder', label: 'Folder', disabled: true },
      ] },
      { id: 'rename', label: 'Rename' },
    ]}
    onClose={close}
    onSelect={select}
  /></main>)
  const parent = screen.getByRole('menuitem', { name: 'Create' })
  act(() => { parent.focus() })
  expect(screen.getByRole('menu', { name: 'Create' })).toBeDefined()
  const audit = await auditSurface('Nested menu', document.body)
  expect(audit.violations).toEqual([])
  expect(audit.incomplete).toEqual([])
  fireEvent.keyDown(parent, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }))
  fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(parent)
  fireEvent.keyDown(parent, { key: 'ArrowRight' })
  const file = screen.getByRole('menuitem', { name: 'File' })
  expect(document.activeElement).toBe(file)
  if (parent.parentElement === null) throw new Error('Menu item has no container')
  fireEvent.mouseLeave(parent.parentElement)
  expect(document.activeElement).toBe(file)
  expect(screen.getByRole('menu', { name: 'Create' })).toBeDefined()
  fireEvent.keyDown(file, { key: 'ArrowDown' })
  const folder = screen.getByRole('menuitem', { name: 'Folder' })
  expect(document.activeElement).toBe(folder)
  fireEvent.click(folder)
  expect(select).not.toHaveBeenCalled()
  fireEvent.keyDown(folder, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(file)
  fireEvent.keyDown(file, { key: 'Escape' })
  expect(document.activeElement).toBe(parent)
  expect(screen.queryByRole('menu', { name: 'Create' })).toBeNull()
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(parent, { key: 'Enter' })
  const reopened = screen.getByRole('menuitem', { name: 'File' })
  expect(document.activeElement).toBe(reopened)
  fireEvent.keyDown(reopened, { key: 'ArrowLeft' })
  expect(document.activeElement).toBe(parent)
  expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(parent, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
})
