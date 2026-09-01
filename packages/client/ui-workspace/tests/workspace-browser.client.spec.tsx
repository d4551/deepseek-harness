// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { WorkspaceBrowserProps } from '../src/client/contract/slots.ts'
import { createWorkspaceViewStore, FLAT_SESSION_ORDER_KEY } from '../src/client/stores.ts'
import { UNGROUPED_KEY } from '../src/client/tree.ts'
import { WorkspaceBrowser } from '../src/client/rows/WorkspaceBrowser.tsx'
import { TYPE_AHEAD_MS } from '../src/client/row-focus.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear(); createWorkspaceViewStore().create().actions.setOrderBy('manual') })

// The seat's key domain is workspace ∪ common; the stub mirrors the real
// lookup chain (namespace, then common vocabulary, then the key).
const t: WorkspaceBrowserProps['t'] = makeTranslate(zh, commonZh)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, ...overrides,
})
const sessionState = (items: readonly SessionSummary[], overrides: Partial<SessionListState> = {}): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined,
  phase: 'ready',
  subagentsByParent: {}, jobsBySession: {},
  currentAddress: undefined,
  ...overrides,
})
const workspace = (id: string, sessionIds: string[], title = id): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const workspaceState = (
  items: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[] = [],
): WorkspaceSnapshot => ({ items, archivedSessionIds, state: 'idle', phase: 'ready', error: null })
const noPendingInteraction: SessionPendingInteractionSnapshot = new Map()
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { effectAllowed: '', dropEffect: '' } })
  fireEvent(row, event)
}

/** Whether the row carrying this label renders as part of the range selection. */
function marked(label: string): boolean {
  return screen.getByText(label).closest('[role="treeitem"]')?.className.includes('multiSelected') === true
}

function dragData(): Pick<DataTransfer, 'effectAllowed' | 'dropEffect' | 'setData'> {
  return { effectAllowed: 'uninitialized', dropEffect: 'none', setData: vi.fn() }
}

function mount(
  overrides: Partial<WorkspaceBrowserProps> = {},
  /** Page shell around the region, for the audit that answers for landmarks. */
  wrapper?: ({ children }: { children: ReactNode }) => ReactElement,
) {
  const store = createWorkspaceViewStore().create()
  const props: WorkspaceBrowserProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useSessions: hook(sessionState([])),
    useSessionPendingInteraction: hook(noPendingInteraction),
    useWorkspaces: hook(workspaceState([])),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    startSession: vi.fn(),
    open: vi.fn(),
    searchSessions: vi.fn(async () => ({ items: [], hasMore: false })),
    searchResultLimit: 20,
    renameSession: vi.fn(async () => {}),
    forkSession: vi.fn(),
    renameWorkspace: vi.fn(async () => {}),
    deleteWorkspace: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    insertWorkspaceBefore: vi.fn(async () => {}),
    insertSessionBefore: vi.fn(async () => {}),
    createWorkspace: vi.fn(async () => workspace('created', [])),
    useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => true, subscribe: () => () => {} }),
    useConnectionGeneration: selector => selector(undefined),
    renderSlot: ((_name: string, owner: { open: boolean }) => (owner.open ? <div data-testid="directory-flow" /> : null)) as never,
    t,
    ...overrides,
  }
  const view = render(<WorkspaceBrowser {...props} />, wrapper === undefined ? {} : { wrapper })
  return { view, props, store }
}

/** Re-render with (possibly) changed props — WorkspaceBrowser has no side channel. */
function rerender(b: ReturnType<typeof mount>, overrides: Partial<WorkspaceBrowserProps>) {
  Object.assign(b.props, overrides)
  b.view.rerender(<WorkspaceBrowser {...b.props} />)
}

describe('WorkspaceBrowser', () => {
  it('workspace hover card shows a POSIX home descendant as ~', () => {
    vi.useFakeTimers()
    try {
      mount({
        useWorkspaces: hook(workspaceState([{
          ...workspace('project', []),
          path: '/home/u/Documents/project',
          title: 'Project',
        }])),
        useConnectionGeneration: selector => selector({ id: 1, host: { home: '/home/u' } }),
      })
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('~/Documents/project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes deleted Workspace view state only after the Workspace baseline is ready', async () => {
    const pending = {
      ...workspaceState([]),
      phase: 'pending' as const,
      state: 'loading' as const,
    }
    const b = mount({ useWorkspaces: hook(pending) })
    act(() => {
      b.store.actions.setGroupExpanded('deleted', true)
      b.store.actions.syncSessionOrderAccount('deleted', ['session'], { session: 1 })
    })
    expect(b.store.getSnapshot().groupExpansion).toEqual({ deleted: true })

    rerender(b, { useWorkspaces: hook(workspaceState([])) })
    await waitFor(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({})
      expect(b.store.getSnapshot().sessionOrderByAccount).toEqual({ [UNGROUPED_KEY]: [] })
      expect(b.store.getSnapshot().sessionUpdatedAtByAccount).toEqual({ [UNGROUPED_KEY]: {} })
    })
  })

  it('renders the grouped tree by default and switches to the flat list via Group by', () => {
    const sessions = sessionState([summary('alpha-s', 2), summary('beta-s', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s']), workspace('beta', ['beta-s'])])),
    })
    expect(screen.getByText('工作区')).toBeTruthy()
    expect(screen.getByText('alpha')).toBeTruthy()
    // Sessions hidden while their group is folded.
    expect(screen.queryByText('alpha-s')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    expect(screen.getByText('分组方式')).toBeTruthy() // the menu heading label
    expect(screen.getByRole('separator')).toBeTruthy()
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      '按工作区', '单列表', '手动排序', '最近更新',
    ])
    expect(screen.getByRole('menuitem', { name: '按工作区' }).querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '手动排序' }).querySelector('svg')).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    // Store-driven flip: title changes, rows flatten newest-first, headers gone.
    expect(b.store.getSnapshot().groupBy).toBe('flat')
    expect(screen.getByText('会话')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(screen.getByText('beta-s')).toBeTruthy()

    // Back to workspace grouping through the same menu.
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    expect(screen.getByRole('menuitem', { name: '手动排序' }).hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: '按工作区' }))
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
    expect(screen.getByText('工作区')).toBeTruthy()

    // Escape closes the menu without picking.
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(b.store.getSnapshot().groupBy).toBe('workspace')
  })

  it('persists flat-list drag order locally and applies Last updated within that account', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const workspaces = workspaceState([
      workspace('alpha', ['one']),
      workspace('beta', ['two']),
    ])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaces),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
        .toEqual(['one', 'two', 'three'])
    })

    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    const three = screen.getByText('three').closest('[role="treeitem"]') as HTMLElement
    three.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
      .toEqual(['two', 'three', 'one'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY])
        .toEqual(['one', 'two', 'three'])
    })

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '手动排序' }))
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(three, 'drop', 180)
    b.view.unmount()

    const restored = mount({ useSessions: hook(sessions), useWorkspaces: hook(workspaces) })
    expect(restored.store.getSnapshot().groupBy).toBe('flat')
    expect(restored.store.getSnapshot().orderBy).toBe('manual')
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('expands a group on click and opens a session row', () => {
    const open = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      open,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('alpha-s'))
    expect(open).toHaveBeenCalledWith(sid('alpha-s'))
    // Collapse hides the row again.
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('alpha-s')).toBeNull()
  })

  it('shows five sessions by default and clears transient show-all when the Workspace collapses', () => {
    const items = Array.from({ length: 7 }, (_, index) => summary(`session-${index + 1}`, 7 - index))
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    fireEvent.click(screen.getByText('alpha'))
    for (const item of items.slice(0, 5)) expect(screen.getByText(item.displayTitle)).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.queryByText('session-7')).toBeNull()

    fireEvent.click(screen.getByRole('treeitem', { name: '展开其余 2 个会话' }))
    expect(screen.getByText('session-6')).toBeTruthy()
    expect(screen.getByText('session-7')).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: '收起' })).toBeTruthy()

    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: false })
    fireEvent.click(screen.getByText('alpha'))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.getByRole('treeitem', { name: '展开其余 2 个会话' })).toBeTruthy()
  })

  it('audits the assembled tree, the grouped list and the search results alike', async () => {
    // The row-level audit renders one row inside a hand-built `tree`; only the
    // assembled region can answer for the containers, the overflow rows, and
    // the second tree a query puts in their place.
    const items = Array.from({ length: 7 }, (_, index) => summary(`session-${index + 1}`, 7 - index))
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', items.slice(0, 6).map(item => item.id)),
        workspace('beta', [items[6]?.id ?? sid('session-7')]),
      ])),
    }, ({ children }) => <main>{children}</main>)
    fireEvent.click(screen.getByText('alpha'))
    const audits = [await auditSurface('WorkspaceBrowser grouped tree', b.view.baseElement)]

    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'session' } })
    audits.push(await auditSurface('WorkspaceBrowser search results', b.view.baseElement))

    // A surface that decided nothing would score 100 for free.
    for (const audit of audits) {
      expect(audit.passed + audit.failed, `${audit.surface} decided no checks`).toBeGreaterThan(0)
    }
    expect(accessibilityFailures(audits, 100)).toBe('')
  })

  it('seats the overflow row in the tree instead of giving it a tab stop of its own', () => {
    const items = Array.from({ length: 7 }, (_, index) => summary(`session-${index + 1}`, 7 - index))
    mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', items.map(item => item.id))])),
    })
    fireEvent.click(screen.getByText('alpha'))
    const rows = () => screen.getAllByRole('treeitem')
    const overflow = () => screen.getByRole('treeitem', { name: '展开其余 2 个会话' })
    expect(rows().filter(row => row.tabIndex === 0)).toHaveLength(1)
    expect(overflow().tabIndex).toBe(-1)
    expect(overflow().getAttribute('aria-level')).toBe('2')
    // A tree row's `aria-expanded` promises child nodes of its own; the rows
    // this one reveals are its siblings, and its label carries the state.
    expect(overflow().hasAttribute('aria-expanded')).toBe(false)

    // The arrows reach it as a row of the list, and Enter opens it once — the
    // browser's own button activation is taken away with the keystroke.
    const last = rows()[rows().length - 2] as HTMLElement
    last.focus()
    fireEvent.keyDown(last, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(overflow())
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' })
    expect(screen.getByText('session-7')).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: '收起' })).toBeTruthy()
  })

  it('keeps the blank New Session outside the five-row folding quota', () => {
    const ordinary = Array.from({ length: 6 }, (_, index) => summary(`session-${index + 1}`, 6 - index))
    const blank = summary('blank', 7, { blank: true })
    const b = mount({
      useSessions: hook(sessionState([blank, ...ordinary], { current: blank.id })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [blank.id, ...ordinary.map(item => item.id)])])),
    })
    expect(screen.getByText('新会话')).toBeTruthy()
    for (const item of ordinary.slice(0, 5)) expect(screen.getByText(item.displayTitle)).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
    expect(screen.getByRole('treeitem', { name: '展开其余 1 个会话' })).toBeTruthy()

    fireEvent.click(screen.getByRole('treeitem', { name: '展开其余 1 个会话' }))
    expect(screen.getByText('session-6')).toBeTruthy()
    fireEvent.click(screen.getByRole('treeitem', { name: '收起' }))
    expect(screen.queryByText('session-6')).toBeNull()

    rerender(b, {
      useSessions: hook(sessionState([{ ...blank, blank: false }, ...ordinary], { current: blank.id })),
    })
    expect(screen.getByText('blank')).toBeTruthy()
    expect(screen.queryByText('session-5')).toBeNull()
    expect(screen.getByRole('treeitem', { name: '展开其余 2 个会话' })).toBeTruthy()
  })

  it('anchors collapsed drags before hidden rows so the source stays visible', async () => {
    const ordinary = Array.from({ length: 6 }, (_, index) => summary(`session-${index + 1}`, 6 - index))
    const blank = summary('blank', 7, { blank: true })
    const insertSessionBefore = vi.fn(async () => {})
    const b = mount({
      useSessions: hook(sessionState([blank, ...ordinary], { current: blank.id })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [blank.id, ...ordinary.map(item => item.id)])])),
      insertSessionBefore,
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha)
        .toEqual(['blank', 'session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6'])
    })

    fireEvent.click(screen.getByRole('treeitem', { name: '展开其余 1 个会话' }))
    const blankRow = screen.getByText('新会话').closest('[role="treeitem"]') as HTMLElement
    const session6 = screen.getByText('session-6').closest('[role="treeitem"]') as HTMLElement
    session6.getBoundingClientRect = () => ({
      top: 200, bottom: 234, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 200, toJSON: () => ({}),
    })
    fireEvent.dragStart(blankRow, { dataTransfer: dragData() })
    fireDrag(session6, 'drop', 230)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha)
      .toEqual(['session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6', 'blank'])

    insertSessionBefore.mockClear()
    fireEvent.click(screen.getByRole('treeitem', { name: '收起' }))
    const collapsedBlank = screen.getByText('新会话').closest('[role="treeitem"]') as HTMLElement
    collapsedBlank.getBoundingClientRect = () => ({
      top: 200, bottom: 234, left: 0, right: 200, width: 200, height: 34,
      x: 0, y: 200, toJSON: () => ({}),
    })
    const session5 = screen.getByText('session-5').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(session5, { dataTransfer: dragData() })
    fireDrag(collapsedBlank, 'drop', 205)
    expect(insertSessionBefore).not.toHaveBeenCalled()

    const session4 = screen.getByText('session-4').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(session4, { dataTransfer: dragData() })
    fireDrag(collapsedBlank, 'drop', 205)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha)
      .toEqual(['session-1', 'session-2', 'session-3', 'session-5', 'session-4', 'session-6', 'blank'])
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('session-4'), sid('session-6'))
    expect(screen.getByText('session-4')).toBeTruthy()
    expect(screen.queryByText('session-6')).toBeNull()
  })

  it('shares one editable order across modes and promotes only while Last updated is active', async () => {
    const initial = sessionState([summary('one', 3), summary('two', 2)])
    const b = mount({
      useSessions: hook(initial),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['two', 'one'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      const rows = screen.getAllByRole('treeitem').slice(1)
      expect(rows[0]?.textContent).toContain('one')
      expect(rows[1]?.textContent).toContain('two')
    })

    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '手动排序' }))
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')

    // User activity updates the timestamp baseline in Manual mode without
    // changing the shared visual order.
    const updated = sessionState([summary('one', 4), summary('two', 2)])
    rerender(b, { useSessions: hook(updated) })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionUpdatedAtByAccount.alpha).toEqual({ one: 4, two: 2 })
    })
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')

    // Entering Last updated performs one complete recency sort.
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['one', 'two'])
      expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('one')
    })

    // A later user activity timestamp promotes that Session once while the
    // mode remains active.
    const promoted = sessionState([summary('one', 4), summary('two', 5)])
    rerender(b, { useSessions: hook(promoted) })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
      expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')
    })

    b.view.unmount()
    const restored = mount({
      useSessions: hook(promoted),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['two', 'one'])])),
    })
    expect(restored.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['two', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1)[0]?.textContent).toContain('two')
  })

  it('archives a session from the row menu and hides archived rows in both modes', async () => {
    const archiveSession = vi.fn(async () => {})
    const b = mount({
      useSessions: hook(sessionState([summary('kept-s', 2), summary('gone-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['kept-s', 'gone-s'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByRole('button', { name: '会话“gone-s”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
    expect(archiveSession).toHaveBeenCalledWith(sid('gone-s'))

    // The archive-set echo hides the row in grouped and flat modes.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['kept-s', 'gone-s'])], [sid('gone-s')])) })
    expect(screen.queryByText('gone-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    expect(screen.getByText('kept-s')).toBeTruthy()
    expect(screen.queryByText('gone-s')).toBeNull()
  })

  it('archives a shift-selected session range inside one workspace group', () => {
    const archiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('a1', 3), summary('a2', 2), summary('a3', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a1', 'a2', 'a3'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('a1'))
    fireEvent.click(screen.getByText('a3'), { shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 3 个会话')

    fireEvent.contextMenu(screen.getByText('a3'), { button: 2, clientX: 30, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 3 个会话' }))
    expect(archiveSession.mock.calls).toEqual([[sid('a1')], [sid('a2')], [sid('a3')]])
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('archives every session between a clicked project and a lower shift-clicked project', () => {
    const archiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([
        summary('a1', 4), summary('b1', 3), summary('c1', 2), summary('c2', 1),
      ])),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['a1']),
        workspace('beta', ['b1']),
        workspace('gamma', ['c1', 'c2']),
      ])),
      archiveSession,
    })
    // Every project stays folded: a range over headers must still answer for
    // the sessions inside them.
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('gamma'), { shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 4 个会话')
    // The plain click also unfolded alpha, so its member row marks with it.
    expect(['alpha', 'a1', 'beta', 'gamma'].map(marked)).toEqual([true, true, true, true])

    fireEvent.contextMenu(screen.getByText('beta'), { button: 2, clientX: 12, clientY: 20 })
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 4 个会话' }))
    expect(archiveSession.mock.calls).toEqual([[sid('a1')], [sid('b1')], [sid('c1')], [sid('c2')]])
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('takes every reachable row on the additive modifier with A and archives the lot', () => {
    const archiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('a1', 3), summary('b1', 2), summary('c1', 1)])),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['a1']),
        workspace('beta', ['b1']),
        workspace('gamma', ['c1']),
      ])),
      archiveSession,
    })
    const seated = screen.getAllByRole('treeitem').find(node => node.tabIndex === 0)
    seated?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'a', ctrlKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 3 个会话')

    fireEvent.contextMenu(document.activeElement as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 3 个会话' }))
    expect(archiveSession.mock.calls).toEqual([[sid('a1')], [sid('b1')], [sid('c1')]])
  })

  it('takes the flat list whole on the additive modifier with A', () => {
    // The flat list owns its own selection, so select-all has to reach it too.
    const archiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))

    const seated = screen.getAllByRole('treeitem').find(node => node.tabIndex === 0)
    seated?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'a', ctrlKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 3 个会话')

    fireEvent.contextMenu(document.activeElement as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 3 个会话' }))
    expect(archiveSession.mock.calls).toEqual([[sid('one')], [sid('two')], [sid('three')]])
  })

  it('counts a Session once when select-all takes its project and the row itself', () => {
    // An expanded project puts both the header that answers for a Session and
    // the Session's own row in the account; the reach is a set, not a sum.
    const archiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('a1', 2), summary('a2', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a1', 'a2'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getAllByRole('treeitem')).toHaveLength(3)

    const seated = screen.getAllByRole('treeitem').find(node => node.tabIndex === 0)
    seated?.focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'a', ctrlKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 2 个会话')

    fireEvent.contextMenu(document.activeElement as HTMLElement)
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 2 个会话' }))
    expect(archiveSession.mock.calls).toEqual([[sid('a1')], [sid('a2')]])
  })

  it('archives a keyboard-selected project range without a pointer at any step', () => {
    const archiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([
        summary('a1', 4), summary('b1', 3), summary('c1', 2), summary('c2', 1),
      ])),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['a1']),
        workspace('beta', ['b1']),
        workspace('gamma', ['c1', 'c2']),
      ])),
      archiveSession,
    })
    // One Tab lands on the head of the list; the arrows move inside it.
    const rows = () => screen.getAllByRole('treeitem')
    const seated = () => rows().find(node => node.tabIndex === 0)
    expect(seated()?.textContent).toContain('alpha')
    seated()!.focus()

    // Shift with an arrow is the keyboard's shift-click, anchored on the row it
    // left: three folded project headers, and every session they hold.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 2 个会话')
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 4 个会话')
    expect(['alpha', 'beta', 'gamma'].map(marked)).toEqual([true, true, true])
    expect(document.activeElement).toBe(screen.getByText('gamma').closest('[role="treeitem"]'))

    // Shift+F10 reaches the row as a contextmenu event with no pointer button.
    fireEvent.contextMenu(document.activeElement!)
    const bulk = screen.getByRole('menuitem', { name: '归档选中的 4 个会话' })
    expect(document.activeElement).toBe(bulk)
    fireEvent.click(bulk)
    expect(archiveSession.mock.calls).toEqual([[sid('a1')], [sid('b1')], [sid('c1')], [sid('c2')]])
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('walks the grouped tree with the arrows and opens a session on Enter', () => {
    const open = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('a1', 3), summary('a2', 2), summary('b1', 1)])),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['a1', 'a2']),
        workspace('beta', ['b1']),
      ])),
      open,
    })
    const rowOf = (label: string) => screen.getByText(label).closest('[role="treeitem"]')
    const seated = () => screen.getAllByRole('treeitem').find(node => node.tabIndex === 0)!
    expect(seated()).toBe(rowOf('alpha'))
    seated().focus()

    // A folded project opens on the disclosure arrow, which puts its sessions
    // in the account the next arrow walks into.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(screen.getByText('a1')).toBeTruthy()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(rowOf('a1'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rowOf('a2'))

    // The collapse arrow steps a session row back out to its header.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(rowOf('alpha'))

    // End reaches the last row of the list; Home comes back to the first.
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(rowOf('beta'))
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(document.activeElement).toBe(rowOf('alpha'))

    // Enter does what a plain click does on the row it lands on.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(open).toHaveBeenCalledWith(sid('a1'))
  })

  it('picks rows with Space and takes the range with Shift+Space in the flat list', () => {
    const archiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    const seated = () => screen.getAllByRole('treeitem').find(node => node.tabIndex === 0)!
    seated().focus()
    fireEvent.keyDown(document.activeElement!, { key: ' ' })
    expect(screen.getByRole('status').textContent).toBe('已选择 1 个会话')
    // Space is the keyboard's Ctrl-click, so pressing it again withdraws the row.
    fireEvent.keyDown(document.activeElement!, { key: ' ' })
    expect(screen.getByRole('status').textContent).toBe('')

    fireEvent.keyDown(document.activeElement!, { key: ' ' })
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    fireEvent.keyDown(document.activeElement!, { key: ' ', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 3 个会话')
    fireEvent.contextMenu(document.activeElement!)
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 3 个会话' }))
    expect(archiveSession.mock.calls).toEqual([[sid('one')], [sid('two')], [sid('three')]])
  })

  it('walks every rendered row, including the ones no range can select', () => {
    mount({
      useSessions: hook(sessionState([summary('loose', 2), summary('a1', 1)], { current: sid('loose') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a1'])])),
    })
    const rowOf = (label: string): HTMLElement =>
      screen.getByText(label).closest<HTMLElement>('[role="treeitem"]')!
    const rows = () => screen.getAllByRole('treeitem')
    // Every treeitem is reachable: a node the arrows can never enter is a node
    // with no keyboard at all.
    expect(rows().every(node => node.hasAttribute('tabindex'))).toBe(true)
    expect(rows().filter(node => node.tabIndex === 0)).toHaveLength(1)

    // The Ungrouped bucket takes no selection state, because no range reaches it.
    const bucket = rowOf('未分组')
    expect(bucket.hasAttribute('aria-selected')).toBe(false)
    expect(bucket.getAttribute('aria-level')).toBe('1')
    expect(rowOf('loose').getAttribute('aria-level')).toBe('2')

    // The tree owns its treeitems directly; the group section is layout, and a
    // hover card's wrapper hides itself rather than standing between the two.
    // The bucket alone renders unwrapped, so a real workspace row and a session
    // row have to answer for the wrapped path.
    expect(bucket.parentElement?.getAttribute('role')).toBe('presentation')
    for (const wrapped of [rowOf('loose')]) {
      expect(wrapped.parentElement?.getAttribute('role')).toBe('none')
    }

    // The arrows walk into and out of the bucket all the same.
    rows().find(node => node.tabIndex === 0)!.focus()
    fireEvent.keyDown(document.activeElement!, { key: 'End' })
    expect(document.activeElement).toBe(rowOf('loose'))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(bucket)
    expect(bucket.tabIndex).toBe(0)

    // Shift from the bucket carries nothing: a row no range reaches is no
    // anchor for one, so the keystroke moves the focus alone.
    fireEvent.keyDown(document.activeElement!, { key: 'End', shiftKey: true })
    expect(document.activeElement).toBe(rowOf('loose'))
    expect(screen.getByRole('status').textContent).toBe('')

    // Shift across it does carry, and still never selects the bucket: the
    // account is the visible reading order, and the bucket is not in it.
    rowOf('alpha').focus()
    fireEvent.keyDown(document.activeElement!, { key: 'End', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 2 个会话')
    expect(marked('loose')).toBe(true)
    expect(marked('未分组')).toBe(false)
    expect(bucket.hasAttribute('aria-selected')).toBe(false)
  })

  it('hands the focus to the surviving row when the archived rows leave', () => {
    const archiveSession = vi.fn(async () => {})
    const b = mount({
      useSessions: hook(sessionState([summary('a1', 3), summary('a2', 2), summary('a3', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a1', 'a2', 'a3'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByText('alpha'))
    fireEvent.click(screen.getByText('a1'))
    fireEvent.click(screen.getByText('a2'), { shiftKey: true })
    const rowOf = (label: string): HTMLElement =>
      screen.getByText(label).closest<HTMLElement>('[role="treeitem"]')!
    rowOf('a3').focus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rowOf('a2'))

    fireEvent.contextMenu(document.activeElement!)
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 2 个会话' }))
    expect(archiveSession.mock.calls).toEqual([[sid('a1')], [sid('a2')]])

    // The archive-set echo removes the rows the focus was standing on; the seat
    // has already fallen back, so the focus follows it instead of the body.
    rerender(b, {
      useSessions: hook(sessionState([summary('a3', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a1', 'a2', 'a3'])], [sid('a1'), sid('a2')])),
    })
    expect(screen.queryByText('a1')).toBeNull()
    expect(document.activeElement).toBe(rowOf('alpha'))
  })

  it('marks the member rows a selected project would archive', () => {
    mount({
      useSessions: hook(sessionState([summary('a1', 3), summary('a2', 2), summary('b1', 1)])),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['a1', 'a2']),
        workspace('beta', ['b1']),
      ])),
    })
    fireEvent.click(screen.getByText('alpha'))
    // Ctrl-picking the open project marks the rows its bulk archive reaches.
    fireEvent.click(screen.getByText('alpha'), { ctrlKey: true })
    expect(['alpha', 'a1', 'a2', 'beta'].map(marked)).toEqual([true, true, true, false])
    expect(screen.getByRole('status').textContent).toBe('已选择 2 个会话')
    // One picked row keeps the per-row Workspace verbs.
    fireEvent.contextMenu(screen.getByText('alpha'), { button: 2, clientX: 6, clientY: 6 })
    expect(screen.getByRole('menuitem', { name: '删除工作区' })).toBeTruthy()
  })

  it('archives a ctrl-picked selection in the flat list and withdraws it on Escape', () => {
    const archiveSession = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
      archiveSession,
    })
    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '单列表' }))
    fireEvent.click(screen.getByText('one'), { ctrlKey: true })
    fireEvent.click(screen.getByText('three'), { ctrlKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 2 个会话')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('status').textContent).toBe('')

    fireEvent.click(screen.getByText('two'), { ctrlKey: true })
    expect(screen.getByRole('status').textContent).toBe('已选择 1 个会话')
    // One picked row keeps the per-row verbs: nothing to widen the menu for.
    fireEvent.contextMenu(screen.getByText('two'), { button: 2, clientX: 5, clientY: 5 })
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
    expect(archiveSession.mock.calls).toEqual([[sid('two')]])
  })

  it('logs and keeps the tree when the archive call rejects', async () => {
    const rejection = new Error('archive exploded')
    const archiveSession = vi.fn(async () => { throw rejection })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      mount({
        useSessions: hook(sessionState([summary('alpha-s', 1)])),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
        archiveSession,
      })
      fireEvent.click(screen.getByText('alpha'))
      fireEvent.click(screen.getByRole('button', { name: '会话“alpha-s”的操作' }), { detail: 1 })
      fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
      await Promise.resolve()
      await Promise.resolve()
      expect(warn).toHaveBeenCalledWith('session archive rejected:', rejection)
      expect(screen.getByText('alpha-s')).toBeTruthy()
    } finally {
      warn.mockRestore()
    }
  })

  it('renders a fork child as a top-level row without a session twist', () => {
    const parent = summary('parent-s', 2)
    const child = { ...summary('child-s', 1), parentId: parent.id }
    mount({
      useSessions: hook(sessionState([parent, child])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['parent-s', 'child-s'])])),
    })
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.getByText('child-s')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /展开|收起/ })).toBeNull()
    expect(screen.getByText('child-s').closest('[role="treeitem"]')?.getAttribute('draggable')).toBe('true')
  })

  it('expands the target group before starting a session from its ＋', () => {
    const startSession = vi.fn()
    const b = mount({
      useSessions: hook(sessionState([summary('alpha-s', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['alpha-s'])])),
      startSession,
    })
    startSession.mockImplementation(() => {
      expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    })
    expect(screen.queryByText('alpha-s')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在“alpha”中新建会话' }))
    expect(b.store.getSnapshot().groupExpansion).toEqual({ alpha: true })
    expect(screen.getByText('alpha-s')).toBeTruthy()
    expect(startSession).toHaveBeenCalledWith(wid('alpha'))
  })

  it('auto-expands the Ungrouped bucket for a loose current session; its header has no menu and its ＋ is inert', () => {
    const startSession = vi.fn()
    mount({
      useSessions: hook(sessionState([summary('loose', 1)], { current: sid('loose') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      startSession,
    })
    // The loose session's group is UNGROUPED_KEY: expanded by the effect.
    expect(screen.getByText('loose')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '工作区“未分组”的操作' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '在“未分组”中新建会话' }))
    expect(startSession).not.toHaveBeenCalled()
  })

  it('keeps an already-expanded group when the selection moves within it', () => {
    const first = sessionState([summary('a', 2), summary('b', 1)], { current: sid('a') })
    const b = mount({
      useSessions: hook(first),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['a', 'b'])])),
    })
    expect(screen.getByText('a')).toBeTruthy()
    // Selection hop inside the same group: the effect re-runs and leaves the
    // expansion list unchanged (no duplicate key, group still open).
    rerender(b, { useSessions: hook({ ...first, current: sid('b') }) })
    expect(screen.getByText('b')).toBeTruthy()
    fireEvent.click(screen.getByText('alpha'))
    expect(screen.queryByText('b')).toBeNull()
  })

  it('shows only the current blank session as the localized New Session, excluded from search', () => {
    const currentBlank = summary('alpha-blank', 9, { blank: true })
    const staleBlank = summary('beta-blank', 8, { blank: true })
    const sessions = sessionState(
      [currentBlank, staleBlank],
      { current: currentBlank.id },
    )
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['alpha-blank']), workspace('beta', ['beta-blank']),
      ])),
    })
    expect(screen.getByText('新会话')).toBeTruthy()
    expect(screen.queryByText('alpha-blank')).toBeNull()
    expect(screen.queryByText('beta-blank')).toBeNull()

    rerender(b, { useSessions: hook({ ...sessions, current: staleBlank.id }) })
    expect(screen.getAllByText('新会话')).toHaveLength(1)
    b.store.actions.setGroupBy('flat')
    rerender(b, {})
    expect(screen.getAllByText('新会话')).toHaveLength(1)
    // Search excludes blank rows entirely — neither the canonical stored
    // title nor the localized display label participates in matching.
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'new session' } })
    expect(screen.queryByText('新会话')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: '新会话' } })
    expect(screen.queryByText('新会话')).toBeNull()
  })

  it('promotes the blank selected by New Session in its grouped and flat orders', async () => {
    const items = [
      summary('old', 100),
      summary('blank', 150, { blank: true }),
      summary('mid', 200),
    ]
    const startSession = vi.fn()
    const b = mount({
      useSessions: hook(sessionState(items)),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['old', 'blank', 'mid'])])),
      startSession,
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'blank', 'mid'])
    })
    startSession.mockImplementation(() => {
      rerender(b, { useSessions: hook(sessionState(items, { current: sid('blank') })) })
    })
    fireEvent.click(screen.getByRole('button', { name: '在“alpha”中新建会话' }))
    expect(startSession).toHaveBeenCalledWith(wid('alpha'))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['blank', 'old', 'mid'])
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['blank'])
    })
    b.store.actions.setGroupBy('flat')
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['blank', 'mid', 'old'])
    })
  })

  it('does not repeat blank promotion after a manual drag or the first prompt', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const b = mount({
      useSessions: hook(sessionState([
        summary('old', 100),
        summary('blank', 150, { blank: true }),
        summary('mid', 200),
      ], { current: sid('blank') })),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['old', 'blank', 'mid'])])),
      insertSessionBefore,
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['blank', 'old', 'mid'])
    })
    const blank = screen.getByText('新会话').closest('[role="treeitem"]') as HTMLElement
    const mid = screen.getByText('mid').closest('[role="treeitem"]') as HTMLElement
    mid.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(blank, { dataTransfer: dragData() })
    fireDrag(mid, 'drop', 180)
    expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'mid', 'blank'])
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('blank'), undefined)

    rerender(b, {
      useSessions: hook(sessionState([
        summary('old', 100),
        summary('blank', 150),
        summary('mid', 200),
      ], { current: sid('blank') })),
    })
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount.alpha).toEqual(['old', 'mid', 'blank'])
    })
  })

  it('shows local metadata matches immediately, then clears back to the grouped tree', async () => {
    vi.useFakeTimers()
    try {
      const sessions = sessionState([
        summary('needle-row', 2, { displayTitle: 'Needle row' }),
        summary('other-row', 1, { displayTitle: 'Other row' }),
      ])
      mount({
        useSessions: hook(sessions),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-row', 'other-row'])])),
      })
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话…')
      fireEvent.change(input, { target: { value: 'needle' } })
      const resultTree = screen.getByRole('tree', { name: '搜索结果' })
      expect(screen.getByText('Needle row')).toBeTruthy()
      expect(screen.queryByText('Other row')).toBeNull()
      const status = screen.getByRole('status')
      expect(status.textContent).toBe('正在搜索会话历史…')
      expect(resultTree.contains(status)).toBe(false)

      fireEvent.change(input, { target: { value: 'zzz' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('无匹配会话')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '清除搜索' }))
      expect(input.value).toBe('')
      expect(screen.getByRole('tree', { name: '会话' })).toBeTruthy()
      // Clicking the field row focuses the input (wide mode).
      fireEvent.click(input.parentElement as HTMLElement)
      expect(document.activeElement).toBe(input)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses an empty search on outside click but keeps a non-empty query expanded', () => {
    mount()
    const search = screen.getByRole('button', { name: '搜索会话' })
    fireEvent.click(search)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话…')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    fireEvent.change(input, { target: { value: 'kept' } })
    fireEvent.click(document.body)
    expect(search.getAttribute('aria-expanded')).toBe('true')
    expect(input.value).toBe('kept')
  })

  it('adds Host content hits with context, shows the result bound, and opens without clearing the query', async () => {
    vi.useFakeTimers()
    try {
      const open = vi.fn()
      const searchSessions = vi.fn(async () => ({
        items: [{ sessionId: sid('body-hit'), snippet: '…the waterfall token appears here…' }],
        hasMore: true,
      }))
      mount({
        useSessions: hook(sessionState([
          summary('body-hit', 1, { displayTitle: 'Research notes' }),
        ])),
        useWorkspaces: hook(workspaceState([
          workspace('research', ['body-hit'], 'Research Workspace'),
        ])),
        open,
        searchSessions,
      })
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话…')
      fireEvent.change(input, { target: { value: 'waterfall token' } })
      expect(screen.getByText('正在搜索会话历史…')).toBeTruthy()
      expect(screen.queryByText('Research notes')).toBeNull()

      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      expect(searchSessions).toHaveBeenCalledWith('waterfall token', expect.any(AbortSignal))
      expect(screen.getByText('Research notes')).toBeTruthy()
      expect(screen.getByText('Research Workspace')).toBeTruthy()
      expect(screen.getByText('…the waterfall token appears here…')).toBeTruthy()
      expect(screen.getByText('仅显示前 20 条结果，请缩小搜索范围。')).toBeTruthy()
      fireEvent.click(screen.getByRole('treeitem'))
      expect(open).toHaveBeenCalledWith(sid('body-hit'))
      expect(input.value).toBe('waterfall token')
    } finally {
      vi.useRealTimers()
    }
  })

  it('walks the tree by typing, the way a long sidebar has to be navigable', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    mount({
      useSessions: hook(sessionState([summary('a1', 3), summary('b1', 2), summary('c1', 1)])),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', ['a1']),
        workspace('apple', ['b1']),
        workspace('cherry', ['c1']),
      ])),
    })
    const rowOf = (label: string) => screen.getByText(label).closest('[role="treeitem"]')
    const seated = screen.getAllByRole('treeitem').find(node => node.tabIndex === 0)
    expect(seated).toBe(rowOf('alpha'))
    seated?.focus()

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'c' })
    expect(document.activeElement).toBe(rowOf('cherry'))

    // Past the buffer window the next character starts its own search, and
    // repeating it walks the rows that begin with it, wrapping.
    vi.advanceTimersByTime(TYPE_AHEAD_MS + 1)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'a' })
    expect(document.activeElement).toBe(rowOf('alpha'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'a' })
    expect(document.activeElement).toBe(rowOf('apple'))
  })

  it('keeps one tab stop across the search results and moves it with the arrows', async () => {
    vi.useFakeTimers()
    try {
      mount({
        useSessions: hook(sessionState([
          summary('one', 1, { displayTitle: 'Waterfall one' }),
          summary('two', 2, { displayTitle: 'Waterfall two' }),
        ])),
      })
      fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'Waterfall' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      const rows = screen.getAllByRole('treeitem')
      expect(rows.map(row => row.tabIndex)).toEqual([0, -1])

      rows[0]?.focus()
      fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' })
      expect(screen.getAllByRole('treeitem').map(row => row.tabIndex)).toEqual([-1, 0])
      expect(document.activeElement).toBe(screen.getAllByRole('treeitem')[1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds programmatic search input to a schema-valid request without splitting an astral character', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => ({ items: [], hasMore: false }))
      mount({ searchSessions })
      const input = screen.getByPlaceholderText<HTMLInputElement>('搜索会话…')
      expect(input.maxLength).toBe(500)
      fireEvent.change(input, { target: { value: 'y'.repeat(501) } })
      expect(input.value).toBe('y'.repeat(500))
      const expected = `prefix${'x'.repeat(493)}`
      fireEvent.change(input, {
        target: { value: `prefix\0${'x'.repeat(493)}😀tail` },
      })

      expect(input.value).toBe(expected)
      expect(input.value.length).toBe(499)
      expect(input.value).not.toContain('\0')
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(searchSessions).toHaveBeenCalledOnce()
      expect(searchSessions).toHaveBeenCalledWith(expected, expect.any(AbortSignal))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps local matches and shows a lightweight warning when Host search fails', async () => {
    vi.useFakeTimers()
    try {
      const searchSessions = vi.fn(async () => { throw new Error('index unavailable') })
      mount({
        useSessions: hook(sessionState([
          summary('local-hit', 1, { displayTitle: 'Needle title' }),
        ])),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['local-hit'])])),
        searchSessions,
      })
      fireEvent.change(screen.getByPlaceholderText('搜索会话…'), {
        target: { value: 'needle' },
      })
      expect(screen.getByText('Needle title')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('Needle title')).toBeTruthy()
      expect(screen.getByText('内容搜索暂不可用，仅显示名称匹配。')).toBeTruthy()
      expect(screen.queryByText('无匹配会话')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a superseded request and ignores its stale result', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst!: (value: {
        items: { sessionId: SessionId; snippet: string }[]
        hasMore: boolean
      }) => void
      const first = new Promise<{
        items: { sessionId: SessionId; snippet: string }[]
        hasMore: boolean
      }>((resolve) => { resolveFirst = resolve })
      const searchSessions = vi.fn((query: string, _signal: AbortSignal) => query === 'first'
        ? first
        : Promise.resolve({
          items: [{ sessionId: sid('second-hit'), snippet: 'second excerpt' }],
          hasMore: false,
        }))
      mount({
        useSessions: hook(sessionState([
          summary('first-hit', 2, { displayTitle: 'Old result' }),
          summary('second-hit', 1, { displayTitle: 'Fresh result' }),
        ])),
        searchSessions,
      })
      const input = screen.getByPlaceholderText('搜索会话…')
      fireEvent.change(input, { target: { value: 'first' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      const firstSignal = searchSessions.mock.calls[0]?.[1] as AbortSignal
      expect(firstSignal.aborted).toBe(false)

      fireEvent.change(input, { target: { value: 'second' } })
      expect(firstSignal.aborted).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('Fresh result')).toBeTruthy()

      await act(async () => {
        resolveFirst({
          items: [{ sessionId: sid('first-hit'), snippet: 'stale excerpt' }],
          hasMore: false,
        })
        await Promise.resolve()
      })
      expect(screen.queryByText('Old result')).toBeNull()
      expect(screen.getByText('Fresh result')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a rejected request after it has been superseded', async () => {
    vi.useFakeTimers()
    try {
      let rejectFirst!: (reason: Error) => void
      const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
      const searchSessions = vi.fn((query: string) => query === 'first'
        ? first
        : Promise.resolve({ items: [], hasMore: false }))
      mount({ searchSessions })
      const input = screen.getByPlaceholderText('搜索会话…')
      fireEvent.change(input, { target: { value: 'first' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })

      fireEvent.change(input, { target: { value: 'second' } })
      await act(async () => {
        rejectFirst(new Error('stale failure'))
        await Promise.resolve()
      })
      expect(screen.queryByText('内容搜索暂不可用，仅显示名称匹配。')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the no-sessions empty state in both modes and resolves an empty search', async () => {
    vi.useFakeTimers()
    try {
      const b = mount()
      expect(screen.getByText('暂无会话')).toBeTruthy()
      b.store.actions.setGroupBy('flat')
      rerender(b, {})
      expect(screen.getByText('暂无会话')).toBeTruthy()
      fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'x' } })
      expect(screen.getByText('正在搜索会话历史…')).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(250) })
      expect(screen.getByText('无匹配会话')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail state renders icon controls that request expansion', () => {
    vi.useFakeTimers()
    try {
      const expandSidebar = vi.fn()
      const b = mount({ wide: false, expandSidebar })
      // No wide chrome in rail state.
      expect(screen.queryByText('工作区')).toBeNull()
      expect(screen.queryByPlaceholderText('搜索会话…')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
      // The wide flip mounts the input and focuses it after the slide.
      rerender(b, { wide: true })
      const input = screen.getByPlaceholderText('搜索会话…')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(input)
      // Wide search button is decorative (tabIndex -1, no expand call).
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      expect(expandSidebar).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the rail-opened search expanded when the initiating click reaches document', () => {
    vi.useFakeTimers()
    try {
      const b = mount({ wide: false })
      fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
      rerender(b, { wide: true })
      // In the browser the rail click keeps bubbling to document after the
      // wide flip mounted the outside-click listener, with the unmounted rail
      // button as its target — outside searchRoot. It must not dismiss the
      // search it just opened.
      fireEvent.click(document.body)
      expect(screen.getByRole('button', { name: '搜索会话' }).getAttribute('aria-expanded')).toBe('true')
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(screen.getByPlaceholderText('搜索会话…'))
      // The gesture has settled: outside clicks dismiss the search again.
      fireEvent.click(document.body)
      expect(screen.getByRole('button', { name: '搜索会话' }).getAttribute('aria-expanded')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rail add-workspace raises the directory flow in place, with no menu and no expansion', () => {
    const expandSidebar = vi.fn()
    mount({ wide: false, expandSidebar, useWorkspaces: hook(workspaceState([workspace('alpha', [])])) })
    fireEvent.click(screen.getByRole('button', { name: '添加工作区' }))
    expect(expandSidebar).not.toHaveBeenCalled()
    // Adding is the header's only action, so the gesture IS that action: no
    // one-row popover, and existing workspaces stay in the tree below.
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'alpha' })).toBeNull()
    expect(screen.getByTestId('directory-flow')).toBeTruthy()
  })

  it('hides the add button when no directory-flow occupant is composed', () => {
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [])])),
      useDirectoryFlow: bindSnapshotSelector({ getSnapshot: () => false, subscribe: () => () => {} }),
    })
    // Nothing to add with, so the header offers no dead button.
    expect(screen.queryByRole('button', { name: '添加工作区' })).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('uses the full expanded Workspace section when resolving a Workspace drop half', () => {
    const insertWorkspaceBefore = vi.fn(async () => {})
    const sessions = sessionState(Array.from({ length: 5 }, (_, index) => summary(`beta-${index}`, index)))
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', sessions.ids),
        workspace('tail', []),
      ])),
      insertWorkspaceBefore,
    })
    fireEvent.click(screen.getByText('beta'))
    const source = screen.getByText('tail').closest('[role="treeitem"]') as HTMLElement
    let targetSection = screen.getByText('beta').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (targetSection.parentElement?.getAttribute('role') !== 'tree') {
      targetSection = targetSection.parentElement as HTMLElement
    }
    targetSection.getBoundingClientRect = () => ({
      top: 100, bottom: 300, left: 0, right: 200, width: 200, height: 200, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    // y=190 is below the header row but still in the top half of the whole
    // expanded section, so the target is before beta rather than after it.
    fireDrag(targetSection, 'drop', 190)
    expect(insertWorkspaceBefore).toHaveBeenCalledWith(wid('tail'), wid('beta'))
  })

  it('draws the first Workspace insertion boundary on the scroll container', () => {
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', []),
      ])),
    })
    const source = screen.getByText('beta').closest('[role="treeitem"]') as HTMLElement
    let firstSection = screen.getByText('alpha').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (firstSection.parentElement?.getAttribute('role') !== 'tree') {
      firstSection = firstSection.parentElement as HTMLElement
    }
    firstSection.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(firstSection, 'dragOver', 105)
    expect(firstSection.parentElement?.className).toContain('listTopDropActive')
    const marker = firstSection.parentElement?.previousElementSibling
    expect(marker?.className).toContain('listTopDropIndicator')
  })

  it('accepts a document-level drop and commits the last Workspace marker on drag end', () => {
    const insertWorkspaceBefore = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([
        workspace('alpha', []),
        workspace('beta', []),
        workspace('tail', []),
      ])),
      insertWorkspaceBefore,
    })
    const source = screen.getByText('tail').closest('[role="treeitem"]') as HTMLElement
    let target = screen.getByText('beta').closest('[role="treeitem"]')?.parentElement as HTMLElement
    while (target.parentElement?.getAttribute('role') !== 'tree') {
      target = target.parentElement as HTMLElement
    }
    target.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(source, { dataTransfer: dragData() })
    fireDrag(target, 'dragOver', 105)
    const outsideDrop = createEvent.drop(document.body)
    Object.defineProperty(outsideDrop, 'dataTransfer', { value: dragData() })
    fireEvent(document.body, outsideDrop)
    expect(outsideDrop.defaultPrevented).toBe(true)
    fireEvent.dragEnd(source)
    expect(insertWorkspaceBefore).toHaveBeenCalledWith(wid('tail'), wid('beta'))
  })

  it('drag reorder reports the anchor to insertSessionBefore and skips no-op drops', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two', 'three'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const rows = screen.getAllByRole('treeitem').slice(1) // drop the group header
    const [one, , three] = rows as [HTMLElement, HTMLElement, HTMLElement]
    three.getBoundingClientRect = () => ({
      top: 200, bottom: 234, left: 0, right: 200, width: 200, height: 34, x: 0, y: 200, toJSON: () => ({}),
    })
    const dataTransfer = dragData()
    fireEvent.dragStart(one, { dataTransfer })
    // Drop on the top half of "three": insert one before three.
    fireDrag(three, 'dragOver', 205)
    fireDrag(three, 'drop', 205)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), sid('three'))

    // Dropping right back onto its own position is a no-op — top half
    // (anchor = itself) and bottom half (anchor = the next root) alike.
    fireEvent.dragStart(one, { dataTransfer })
    one.getBoundingClientRect = () => ({
      top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34, x: 0, y: 100, toJSON: () => ({}),
    })
    fireDrag(one, 'dragOver', 105)
    fireDrag(one, 'drop', 105)
    expect(insertSessionBefore).toHaveBeenCalledTimes(1)
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(one, 'drop', 130)
    expect(insertSessionBefore).toHaveBeenCalledTimes(1)
  })

  it('persists Ungrouped drag order in both modes without writing a Host Workspace account', async () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 3), summary('two', 2), summary('three', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('未分组'))

    const dragAfter = (sourceTitle: string, targetTitle: string): void => {
      const source = screen.getByText(sourceTitle).closest('[role="treeitem"]') as HTMLElement
      const target = screen.getByText(targetTitle).closest('[role="treeitem"]') as HTMLElement
      target.getBoundingClientRect = () => ({
        top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
      })
      fireEvent.dragStart(source, { dataTransfer: dragData() })
      fireDrag(target, 'drop', 180)
    }

    dragAfter('one', 'three')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    dragAfter('two', 'one')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['three', 'one', 'two'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '视图选项' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '最近更新' }))
    await waitFor(() => {
      expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['one', 'two', 'three'])
    })
    dragAfter('one', 'three')
    expect(b.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    expect(insertSessionBefore).not.toHaveBeenCalled()

    b.view.unmount()
    const restored = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([])),
      insertSessionBefore,
    })
    expect(restored.store.getSnapshot().sessionOrderByAccount[UNGROUPED_KEY]).toEqual(['two', 'three', 'one'])
    expect(screen.getAllByRole('treeitem').slice(1).map(row => row.textContent)).toEqual([
      expect.stringContaining('two'),
      expect.stringContaining('three'),
      expect.stringContaining('one'),
    ])
  })

  it('still sends the reorder when the dragged row left the group mid-drag', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    const b = mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const one = screen.getByText('one').closest('[role="treeitem"]') as HTMLElement
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    // The host dropped "one" from the workspace account while the drag is in
    // flight: the source index is gone but the drop still resolves its anchor.
    rerender(b, { useWorkspaces: hook(workspaceState([workspace('alpha', ['two'])])) })
    const two = screen.getByText('two').closest('[role="treeitem"]') as HTMLElement
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireDrag(two, 'drop', 155)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), sid('two'))
  })

  it('drag end without a drop clears markers; bottom-half drop appends past the last row', () => {
    const insertSessionBefore = vi.fn(async () => {})
    const sessions = sessionState([summary('one', 2), summary('two', 1)])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    const dataTransfer = dragData()
    fireEvent.dragStart(one, { dataTransfer })
    fireEvent.dragEnd(one)
    // The drag ended: rows no longer accept drops.
    fireDrag(two, 'drop', 180)
    expect(insertSessionBefore).not.toHaveBeenCalled()

    // Bottom half of the last row: append (anchor omitted).
    fireEvent.dragStart(one, { dataTransfer })
    fireDrag(two, 'dragOver', 180)
    fireDrag(two, 'drop', 180)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), undefined)
  })

  it('accepts a document-level drop and commits the last Session marker on drag end', () => {
    const insertSessionBefore = vi.fn(async () => {})
    mount({
      useSessions: hook(sessionState([summary('one', 2), summary('two', 1)])),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
      insertSessionBefore,
    })
    fireEvent.click(screen.getByText('alpha'))
    const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
    two.getBoundingClientRect = () => ({
      top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
    })
    fireEvent.dragStart(one, { dataTransfer: dragData() })
    fireDrag(two, 'dragOver', 180)
    const outsideDrop = createEvent.drop(document.body)
    Object.defineProperty(outsideDrop, 'dataTransfer', { value: dragData() })
    fireEvent(document.body, outsideDrop)
    expect(outsideDrop.defaultPrevented).toBe(true)
    fireEvent.dragEnd(one)
    expect(insertSessionBefore).toHaveBeenCalledWith(wid('alpha'), sid('one'), undefined)
  })

  it('logs and keeps the order when the reorder call rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const insertSessionBefore = vi.fn(async () => { throw new Error('stale anchor') })
      const sessions = sessionState([summary('one', 2), summary('two', 1)])
      mount({
        useSessions: hook(sessions),
        useWorkspaces: hook(workspaceState([workspace('alpha', ['one', 'two'])])),
        insertSessionBefore,
      })
      fireEvent.click(screen.getByText('alpha'))
      const [one, two] = screen.getAllByRole('treeitem').slice(1) as [HTMLElement, HTMLElement]
      two.getBoundingClientRect = () => ({
        top: 150, bottom: 184, left: 0, right: 200, width: 200, height: 34, x: 0, y: 150, toJSON: () => ({}),
      })
      const dataTransfer = dragData()
      fireEvent.dragStart(one, { dataTransfer })
      fireDrag(two, 'drop', 180)
      await waitFor(() => { expect(warn).toHaveBeenCalledWith('session reorder rejected:', expect.any(Error)) })
    } finally {
      warn.mockRestore()
    }
  })

  it('renames a workspace through the row menu dialog', async () => {
    let resolveRename!: () => void
    const renameWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveRename = resolve }))
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha'), workspace('beta', [], 'Beta')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = screen.getByLabelText<HTMLInputElement>('工作区名称')
    expect(input.value).toBe('Alpha')
    // Unchanged and blank names stay blocked.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    // A duplicate of another workspace's title shows the inline conflict.
    fireEvent.change(input, { target: { value: ' Beta ' } })
    expect(screen.getByRole('alert').textContent).toBe('已存在名为“Beta”的工作区。')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '重命名' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Gamma' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Gamma')
    // While renaming: input disabled, close blocked, Enter ignored.
    expect(input.disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { resolveRename() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rename via Enter, failure surfaces the error, Cancel closes', async () => {
    const renameWorkspace = vi.fn(async () => { throw new Error('rename conflict') })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    const input = screen.getByLabelText<HTMLInputElement>('工作区名称')
    // Enter with a blocked draft (unchanged) does nothing.
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(renameWorkspace).toHaveBeenCalledWith(wid('alpha'), 'Renamed')
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('rename conflict') })
    // The dialog stays for retry; typing clears the error; Cancel closes.
    fireEvent.change(input, { target: { value: 'Renamed2' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports non-Error rename failures as text', async () => {
    const renameWorkspace = vi.fn(async () => { throw 'denied' })
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      renameWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    fireEvent.change(screen.getByLabelText('工作区名称'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
  })

  it('confirms Workspace deletion, explains retention, and blocks duplicate submission', async () => {
    let resolveDelete!: () => void
    const deleteWorkspace = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve }))
    const browser = mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', ['session'], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    const dialog = screen.getByRole('dialog', { name: '删除工作区' })
    expect(dialog.textContent).toContain('将把“Alpha”从工作区列表中移除')
    expect(dialog.textContent).toContain('文件夹与会话记录会保留')
    expect(dialog.textContent).toContain('其会话将显示在“未分组”下')

    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '删除工作区' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(deleteWorkspace).toHaveBeenCalledOnce()
    expect(deleteWorkspace).toHaveBeenCalledWith(wid('alpha'))
    expect(confirm.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
    // The selection's live region is always mounted, so the delete dialog's own
    // status is named by its text rather than by being the only one.
    expect(screen.getAllByRole('status').map(node => node.textContent))
      .toContain('正在删除工作区…')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    await act(async () => { resolveDelete() })
    // RPC success alone does not close: the component waits until its
    // useWorkspaces projection has committed the removal, preventing a stale
    // Workspace frame from leaking into the next gesture.
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    rerender(browser, { useWorkspaces: hook(workspaceState([])) })
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('keeps the delete dialog open on failure and allows retry or cancellation', async () => {
    const deleteWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockRejectedValueOnce('denied')
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '删除工作区' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('storage unavailable') })
    expect(screen.getByRole('dialog', { name: '删除工作区' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除工作区' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('denied') })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('Cancel, Escape, and Close dismiss deletion without calling the action', () => {
    const deleteWorkspace = vi.fn(async () => {})
    mount({
      useWorkspaces: hook(workspaceState([workspace('alpha', [], 'Alpha')])),
      deleteWorkspace,
    })
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: '工作区“Alpha”的操作' }), { detail: 1 })
      fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    }
    open()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    open()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(deleteWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '删除工作区' })).toBeNull()
  })

  it('search hides drag affordances (rows are not draggable during search)', () => {
    const sessions = sessionState([summary('needle-a', 2, { displayTitle: 'Needle A' })])
    mount({
      useSessions: hook(sessions),
      useWorkspaces: hook(workspaceState([workspace('alpha', ['needle-a'])])),
    })
    fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'needle' } })
    const row = screen.getByText('Needle A').closest('[role="treeitem"]') as HTMLElement
    expect(row.hasAttribute('draggable')).toBe(false)
  })
})
