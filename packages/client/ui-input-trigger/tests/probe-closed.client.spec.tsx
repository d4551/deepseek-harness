// @vitest-environment jsdom
/**
 * Listbox ARIA purity: pending groups render their role=status skeletons
 * OUTSIDE the listbox (a live region is not an allowed listbox child), and an
 * all-pending open menu renders no empty listbox at all (an option-less
 * listbox violates aria-required-children).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import type { MenuState, TriggerHit } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { MenuView } from '../src/client/MenuView.tsx'

const hit: TriggerHit = {
  trigger: '/',
  query: 'g',
  quoted: false,
  position: 'leading',
  span: { start: 0, end: 2, draftRev: 1 },
}

const t = makeTranslate(zh, commonZh)

function openWith(groups: MenuState['groups']): MenuState {
  return { open: true, hit, generation: 1, groups, highlight: null }
}

function mountView(state: MenuState) {
  const menu = createSnapshotStore<MenuState>(state)
  const headers = createSnapshotStore<ReadonlyMap<string, readonly never[]>>(new Map())
  return render(
    <MenuView
      menu={menu}
      headers={headers}
      onPick={vi.fn()}
      onCrumb={vi.fn()}
      onHover={vi.fn()}
      onRetry={vi.fn()}
      onDismiss={vi.fn()}
      t={t}
    />,
  )
}

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { cleanup() })

describe('MenuView listbox ARIA purity', () => {
  it('keeps pending status skeletons out of the listbox', () => {
    mountView(openWith([
      { source: 'command', status: 'ready', items: [{ name: 'goal' }] },
      { source: 'skill', status: 'pending', items: [] },
    ]))
    const listbox = screen.getByRole('listbox')
    expect(screen.getByRole('option', { name: 'goal' })).toBeTruthy()
    const status = screen.getByRole('status', { name: '正在加载…' })
    expect(listbox.contains(status)).toBe(false)
  })

  it('renders no listbox when every group is still pending', () => {
    mountView(openWith([{ source: 'skill', status: 'pending', items: [] }]))
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByRole('status', { name: '正在加载…' })).toBeTruthy()
  })
})
