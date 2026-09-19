// @vitest-environment jsdom
/**
 * Pending groups announce their status beside the command list. An
 * all-pending open menu renders loading feedback without an empty list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import type { MenuState, TriggerHit } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { MenuView, type MenuViewProps } from '../src/client/MenuView.tsx'

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
      onPick={vi.fn<MenuViewProps['onPick']>()}
      onCrumb={vi.fn<MenuViewProps['onCrumb']>()}
      onHover={vi.fn<MenuViewProps['onHover']>()}
      onRetry={vi.fn<MenuViewProps['onRetry']>()}
      onDismiss={vi.fn<MenuViewProps['onDismiss']>()}
      t={t}
    />,
  )
}

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn<Element['scrollIntoView']>() })
afterEach(() => { cleanup() })

describe('MenuView loading announcements', () => {
  it('keeps pending status skeletons out of the command list', () => {
    mountView(openWith([
      { source: 'command', status: 'ready', items: [{ name: 'goal' }] },
      { source: 'skill', status: 'pending', items: [] },
    ]))
    const listbox = screen.getByRole('list')
    expect(screen.getByRole('button', { name: 'goal' })).toBeTruthy()
    const status = screen.getByRole('status', { name: '正在加载…' })
    expect(listbox.contains(status)).toBe(false)
  })

  it('renders no list when every group is still pending', () => {
    mountView(openWith([{ source: 'skill', status: 'pending', items: [] }]))
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByRole('status', { name: '正在加载…' })).toBeTruthy()
  })
})
