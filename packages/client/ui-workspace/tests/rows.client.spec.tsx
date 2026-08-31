// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { RowDragProps, RowMultiSelection, RowSeat } from '../src/client/rows/Rows.tsx'
import { ProjectRowItem, SearchResultItem, SessionNodeItem } from '../src/client/rows/Rows.tsx'
import type { GroupNode, SearchResultNode, SessionNode } from '../src/client/tree.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as never

/** Default tab-order seat: the row under test holds its list's tab stop. */
function seatOf(rowKey = 'session:row', level = 1): RowSeat {
  return { rowKey, seated: true, level, move: vi.fn() }
}

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

/** Half detection reads the row rect; jsdom rects are all-zero by default. */
function stubRect(row: HTMLElement): void {
  row.getBoundingClientRect = () => ({
    top: 100, bottom: 134, left: 0, right: 200, width: 200, height: 34,
    x: 0, y: 100, toJSON: () => ({}),
  })
}

function dragProps(overrides: Partial<RowDragProps> = {}): RowDragProps {
  return {
    start: vi.fn(), active: false, marker: null,
    hover: vi.fn(), drop: vi.fn(), end: vi.fn(),
    ...overrides,
  }
}

/** Install the async browser clipboard and restore its prior host shape. */
function installClipboard(writeText: (text: string) => Promise<void>): () => void {
  const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  return () => {
    if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', prior)
  }
}

const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() }

/** jsdom lacks DragEvent — the fireEvent fallback drops clientY, so pin it on the built event. */
function fireDrag(row: HTMLElement, kind: 'dragOver' | 'drop', clientY: number): void {
  const event = kind === 'dragOver' ? createEvent.dragOver(row) : createEvent.drop(row)
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: { ...dataTransfer } })
  fireEvent(row, event)
}

describe('workspace browser rows', () => {
  it('omits only an empty leading status slot in the hierarchy-free flat list', () => {
    const idle: SessionNode = {
      id: sid('flat'), title: 'Flat Session', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const view = render(<SessionNodeItem seat={seatOf()} node={idle} currentId={undefined} now={0} onOpen={vi.fn()}
      onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} flat t={t} />)
    const title = screen.getByText('Flat Session')
    expect(title.previousElementSibling).toBeNull()

    view.rerender(<SessionNodeItem seat={seatOf()} node={{ ...idle, running: true }} currentId={undefined} now={0}
      onOpen={vi.fn()} onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} flat t={t} />)
    expect(screen.getByText('Flat Session').previousElementSibling?.querySelector('[data-state="ongoing"]')).toBeTruthy()
  })

  it('renders a selected content-search row and opens only its session', () => {
    const onOpen = vi.fn()
    const result: SearchResultNode = {
      id: sid('result'),
      title: 'Result title',
      workspace: 'Workspace context',
      running: true,
      runningSubagentCount: 0,
      completed: false,
      snippet: 'matching message excerpt',
    }
    render(<SearchResultItem result={result} currentId={result.id} onOpen={onOpen} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Workspace context')).toBeTruthy()
    expect(screen.getByText('matching message excerpt')).toBeTruthy()
    expect(row.querySelector('[data-state="ongoing"]')).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(row.hasAttribute('draggable')).toBe(false)
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(result.id)
  })

  it.each([
    ['approval', '等待审批'],
    ['plan-review', '计划待审'],
    ['question', '等待回答'],
  ] as const)('shows %s ahead of running in search results', (pendingInteraction, label) => {
    const result: SearchResultNode = {
      id: sid(pendingInteraction), title: 'Needs input', workspace: 'Project',
      pendingInteraction, running: true, runningSubagentCount: 0, completed: false,
    }
    render(<SearchResultItem result={result} currentId={undefined} onOpen={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="warning"]')).toBeTruthy()
    expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText(label)).toBeTruthy()
  })

  it('renders an active Workspace and keeps its create action separate from toggling', () => {
    const onToggle = vi.fn()
    const onCreate = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 1, expanded: true, containsCurrent: true, sessions: [], memberIds: [],
    }
    render(<ProjectRowItem seat={seatOf()} group={group} onToggle={onToggle} onCreate={onCreate} t={t} />)

    expect(screen.getByRole('treeitem').getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '在“Project”中新建会话' }))
    expect(onCreate).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Project'))
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('renders and opens a selected running Session row', () => {
    const node: SessionNode = {
      id: sid('session'), title: 'Session', blank: false, running: true,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const onOpen = vi.fn()
    render(
      <SessionNodeItem seat={seatOf()} node={node} currentId={node.id} now={0} onOpen={onOpen}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />,
    )

    const row = screen.getByRole('treeitem')
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.hasAttribute('aria-expanded')).toBe(false)
    expect(screen.queryByRole('button', { name: /展开|收起/ })).toBeNull()
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(node.id)
  })

  it('shows the green done dot only on a finished, unviewed session (live activity wins the slot)', () => {
    const renderRow = (over: Partial<SessionNode>) => render(
      <SessionNodeItem seat={seatOf()}
        node={{
          id: sid('s1'), title: 'One', blank: false, running: false,
          runningSubagentCount: 0, completed: false, updatedAt: 0, ...over,
        }}
        currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t}
      />,
    )
    const stateDot = (view: ReturnType<typeof renderRow>) =>
      view.container.querySelector('[data-state]')
    // No completion reminder, not running: no state dot at all.
    const plain = renderRow({})
    expect(stateDot(plain)).toBeNull()
    plain.unmount()
    // Completed while unviewed: the green done dot.
    const done = renderRow({ completed: true })
    expect(done.container.querySelector('[data-state="done"]')).not.toBeNull()
    done.unmount()
    // Running wins the slot: the animated ongoing dot, no done dot.
    const running = renderRow({ completed: true, running: true })
    expect(running.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(running.container.querySelector('[data-state="done"]')).toBeNull()
    running.unmount()
    // Descendant activity also wins until the last running descendant stops.
    const delegated = renderRow({ completed: true, runningSubagentCount: 1 })
    expect(delegated.container.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(delegated.container.querySelector('[data-state="done"]')).toBeNull()
  })

  it('shows descendant activity without describing an idle parent as running', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('owner'), title: 'Delegating', blank: false, running: false,
        runningSubagentCount: 2, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelector('[data-state="ongoing"]')).not.toBeNull()
      expect(screen.getByText('2 个子代理运行中')).toBeTruthy()
      expect(screen.queryByText('进行中')).toBeNull()

      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('2 个子代理运行中')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps descendant activity secondary while the parent is running', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('owner'), title: 'Delegating', blank: false, running: true,
        runningSubagentCount: 1, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelectorAll('[data-state="ongoing"]')).toHaveLength(1)
      expect(screen.getByText('进行中')).toBeTruthy()
      expect(screen.getByText('1 个子代理运行中')).toBeTruthy()

      fireEvent.pointerEnter(row.parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('进行中')).toHaveLength(2)
      expect(screen.getAllByText('1 个子代理运行中')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps child activity as a secondary status while user attention is primary', () => {
    const node: SessionNode = {
      id: sid('owner'), title: 'Needs input', blank: false, pendingInteraction: 'question',
      running: false, runningSubagentCount: 1, completed: false, updatedAt: 0,
    }
    render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
    const row = screen.getByRole('treeitem')
    expect(row.querySelector('[data-state="warning"]')).not.toBeNull()
    expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
    expect(screen.getByText('等待回答')).toBeTruthy()
    expect(screen.getByText('1 个子代理运行中')).toBeTruthy()
  })

  it('shows the green done dot on a finished search result row', () => {
    render(<SearchResultItem
      result={{
        id: sid('result'), title: 'Done', workspace: 'Workspace', running: false,
        runningSubagentCount: 0, completed: true,
      }}
      currentId={undefined} onOpen={vi.fn()} t={t}
    />)
    expect(screen.getByRole('treeitem').querySelector('[data-state="done"]')).not.toBeNull()
  })

  it('workspace row menu opens on the ellipsis, renames, and shows the danger delete row', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    const onToggle = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [], memberIds: [],
    }
    render(<ProjectRowItem seat={seatOf()}
      group={group} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: onRename, delete: onDelete }} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '工作区“Project”的操作' }), { detail: 1 })
    // Opening the menu neither toggles the group nor renames yet.
    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: '删除工作区' }).className).toMatch(/danger/)
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(onRename).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '工作区“Project”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '删除工作区' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onRename).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.click(screen.getByRole('button', { name: '工作区“Project”的操作' }), { detail: 1 })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('workspace hover card shows its details and copies the full directory path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [], memberIds: [],
      }
      render(<ProjectRowItem seat={seatOf()} group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      // Card body: full title + cwd + absolute creation time.
      expect(screen.getAllByText('Project')).toHaveLength(2)
      expect(screen.getByText('/projects/project')).toBeTruthy()
      expect(screen.getByText(/^创建于 \d+年\d+月\d+日 /)).toBeTruthy()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制: /projects/project' })) })
      expect(writeText).toHaveBeenCalledWith('/projects/project')
      expect(screen.getByRole('status').textContent).toBe('已复制')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it('workspace hover card shows a POSIX home descendant as ~ and still copies the full path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: '/home/u/Documents/project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [], memberIds: [],
      }
      render(<ProjectRowItem seat={seatOf()} group={group} home="/home/u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('~/Documents/project')).toBeTruthy()
      expect(screen.queryByText('/home/u/Documents/project')).toBeNull()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制: /home/u/Documents/project' })) })
      expect(writeText).toHaveBeenCalledWith('/home/u/Documents/project')
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it('workspace hover card without a directory omits the path and copy action', async () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: undefined, createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [], memberIds: [],
      }
      render(<ProjectRowItem seat={seatOf()} group={group} home="/home/u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('Project')).toHaveLength(2)
      expect(screen.getByText(/^创建于 \d+年\d+月\d+日 /)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^复制:/ })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('workspace hover card leaves a Windows path verbatim', async () => {
    vi.useFakeTimers()
    try {
      const group: GroupNode = {
        key: 'project', workspaceId: wid('project'), cwd: 'C:\\Users\\u\\project', createdAt: 0, label: 'Project',
        sessionCount: 0, expanded: false, containsCurrent: false, sessions: [], memberIds: [],
      }
      render(<ProjectRowItem seat={seatOf()} group={group} home="C:\\Users\\u" onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('C:\\Users\\u\\project')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ungrouped bucket renders no workspace menu', () => {
    const group: GroupNode = {
      key: '', workspaceId: undefined, cwd: undefined, createdAt: undefined, label: 'Ungrouped',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [], memberIds: [],
    }
    render(<ProjectRowItem seat={seatOf()} group={group} onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    expect(screen.queryByRole('button', { name: /工作区/ })).toBeNull()
  })

  it('blank New Session rows carry no menu, no time label, and no hover-card time', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s-blank'), title: 'ignored', blank: true, running: false,
        runningSubagentCount: 0, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem seat={seatOf()} node={node} currentId={node.id} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      // The placeholder has no content yet: no row verbs, no "now" stamp.
      expect(screen.queryByRole('button', { name: /会话.*的操作/ })).toBeNull()
      expect(screen.queryByText('刚刚')).toBeNull()
      // The hover card keeps title + status but drops the timestamp line.
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('新会话').length).toBeGreaterThanOrEqual(2)
      expect(screen.getByText('空闲')).toBeTruthy()
      expect(screen.queryByText('刚刚')).toBeNull()
      expect(screen.getByText('空闲').closest('[role="button"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('session row menu opens without opening the session and dispatches rename, fork, and archive', () => {
    const onOpen = vi.fn()
    const onRename = vi.fn()
    const onFork = vi.fn()
    const onArchive = vi.fn()
    const node: SessionNode = {
      id: sid('s1'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={onOpen}
      onRename={onRename} onFork={onFork} onArchive={onArchive} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '会话“One”的操作' }), { detail: 1 })
    expect(onOpen).not.toHaveBeenCalled()
    // Archive is not destructive (log and accounting slot remain): no danger styling.
    expect(screen.getByRole('menuitem', { name: '归档会话' }).className).not.toMatch(/danger/)
    // Rename dispatches with the current display title (dialog prefill).
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onRename).toHaveBeenCalledWith(node.id, 'One')
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '会话“One”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '分叉会话' }))
    expect(onFork).toHaveBeenCalledWith(node.id)
    // Archive dispatches without opening the session.
    fireEvent.click(screen.getByRole('button', { name: '会话“One”的操作' }), { detail: 1 })
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
    expect(onArchive).toHaveBeenCalledWith(node.id)
    expect(onRename).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
    // Escape closes without selecting (Menu onClose path).
    fireEvent.click(screen.getByRole('button', { name: '会话“One”的操作' }), { detail: 1 })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })


  it('shows the hover card after the dwell and suppresses it while the row menu is open', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Hovered', blank: false, running: true,
        runningSubagentCount: 0, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={60_000} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      const wrapper = screen.getByRole('treeitem').parentElement as HTMLElement
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(500) })
      // Card body: full title + relative time + running status.
      expect(screen.getAllByText('Hovered')).toHaveLength(2)
      expect(screen.getByText('1分钟前')).toBeTruthy()
      expect(screen.getAllByText('进行中')).toHaveLength(2)
      fireEvent.pointerLeave(wrapper)
      // Menu open (disabled=true) suppresses the card for the same hover.
      fireEvent.click(screen.getByRole('button', { name: '会话“Hovered”的操作' }), { detail: 1 })
      fireEvent.pointerEnter(wrapper)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.queryByText('1分钟前')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['approval', '等待审批'],
    ['plan-review', '计划待审'],
    ['question', '等待回答'],
  ] as const)('shows %s as warning ahead of the running state', (pendingInteraction, label) => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid(pendingInteraction), title: 'Needs input', blank: false,
        pendingInteraction, running: true, runningSubagentCount: 0, completed: false, updatedAt: 0,
      }
      const view = render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      const row = screen.getByRole('treeitem')
      expect(row.querySelector('[data-state="warning"]')).toBeTruthy()
      expect(row.querySelector('[data-state="ongoing"]')).toBeNull()
      expect(screen.getByText(label)).toBeTruthy()

      view.rerender(<SessionNodeItem seat={seatOf()} node={{ ...node, running: false }} currentId={undefined} now={0}
        onOpen={vi.fn()} onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      expect(screen.getByRole('treeitem').querySelector('[data-state="warning"]')).toBeTruthy()

      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText(label)).toHaveLength(2)
      expect(document.querySelectorAll('[data-state="warning"]')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('idle hover card shows the Idle status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Quiet', blank: false, running: false,
        runningSubagentCount: 0, completed: false, updatedAt: 0,
      }
      render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByText('空闲')).toBeTruthy()
      expect(screen.getAllByText('刚刚')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('completed hover card shows the Completed status line', () => {
    vi.useFakeTimers()
    try {
      const node: SessionNode = {
        id: sid('s1'), title: 'Done', blank: false, running: false,
        runningSubagentCount: 0, completed: true, updatedAt: 0,
      }
      render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
      fireEvent.pointerEnter(screen.getByRole('treeitem').parentElement as HTMLElement)
      act(() => { vi.advanceTimersByTime(500) })
      // Row's visually-hidden reminder label plus the hover card's status line.
      expect(screen.getAllByText('已完成')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('draggable row wires start/end and gates hover/drop on an active same-group drag', () => {
    const node: SessionNode = {
      id: sid('s1'), title: 'Drag me', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const inactive = dragProps()
    const { rerender } = render(
      <SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} drag={inactive} t={t} />,
    )
    const row = screen.getByRole('treeitem')
    stubRect(row)
    expect(row.getAttribute('draggable')).toBe('true')
    fireEvent.dragStart(row, { dataTransfer })
    expect(inactive.start).toHaveBeenCalledOnce()
    // Inactive drag: hover and drop are rejected.
    fireEvent.dragOver(row, { dataTransfer })
    fireEvent.drop(row, { dataTransfer })
    expect(inactive.hover).not.toHaveBeenCalled()
    expect(inactive.drop).not.toHaveBeenCalled()
    fireEvent.dragEnd(row)
    expect(inactive.end).toHaveBeenCalledOnce()

    const active = dragProps({ active: true, marker: 'before' })
    rerender(
      <SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} drag={active} t={t} />,
    )
    stubRect(screen.getByRole('treeitem'))
    // Top half hovers/drops 'before'; bottom half 'after' (row mid = 117).
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 105)
    expect(active.hover).toHaveBeenCalledWith('before')
    fireDrag(screen.getByRole('treeitem'), 'dragOver', 130)
    expect(active.hover).toHaveBeenCalledWith('after')
    fireDrag(screen.getByRole('treeitem'), 'drop', 130)
    expect(active.drop).toHaveBeenCalledWith('after')

    const after = dragProps({ active: true, marker: 'after' })
    rerender(
      <SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
        onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} drag={after} t={t} />,
    )
    expect(screen.getByRole('treeitem').className).toMatch(/dropAfter/)
  })
})

/**
 * Session rows are the workspace's navigation: a user reaches every session
 * through them, so an unnamed control here is one there is no way around.
 * Audited idle and running, against the same fixed WCAG A/AA rule set and
 * floor the primitives lane holds.
 */
describe('workspace rows accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for a session row', async () => {
    const node: SessionNode = {
      id: sid('a11y'), title: 'Audited Session', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const ranged = {
      active: true, count: 2, archivableCount: 2,
      rowKey: 'session:row', seated: true, move: vi.fn(),
      extend: vi.fn(), toggle: vi.fn(), anchor: vi.fn(), archiveSelected: vi.fn(),
    }
    const surfaces = [
      ['SessionNodeItem idle', false, false],
      ['SessionNodeItem running', true, false],
      ['SessionNodeItem multi-selected', false, true],
    ] as const
    const audits: SurfaceAudit[] = []
    for (const [surface, running, selected] of surfaces) {
      // A row is `role="treeitem"`, which ARIA requires to sit inside a
      // `tree`; WorkspaceBrowser provides that container in the product, so
      // auditing the row without one reports the harness's omission rather
      // than a defect. The `main` landmark is the page shell's, for the same
      // reason.
      const { baseElement } = render(
        <main>
          <div role="tree" aria-label="Sessions" aria-multiselectable="true">
            <SessionNodeItem seat={seatOf()}
              node={{ ...node, running }} currentId={undefined} now={0} onOpen={vi.fn()}
              onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()}
              {...selected ? { selection: ranged } : {}}
              flat t={t}
            />
          </div>
        </main>,
      )
      audits.push(await auditSurface(surface, baseElement))
      cleanup()
    }

    // A surface that decided nothing would score 100 for free.
    for (const audit of audits) {
      expect(audit.passed + audit.failed, `${audit.surface} decided no checks`).toBeGreaterThan(0)
    }
    expect([...new Set(audits.flatMap(audit => audit.undecidedRules))]).toEqual(['color-contrast'])
    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
  it('opens the workspace row menu under the pointer on right-click and leaves the bucket alone', () => {
    const onRename = vi.fn()
    const onToggle = vi.fn()
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [], memberIds: [],
    }
    const view = render(<ProjectRowItem seat={seatOf()}
      group={group} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: onRename, delete: vi.fn() }} t={t}
    />)
    fireEvent.contextMenu(screen.getByText('Project'), { button: 2, clientX: 120, clientY: 240 })
    // Right-click opens the same list the ... button does, without toggling the group.
    expect(onToggle).not.toHaveBeenCalled()
    const list = screen.getByRole('menu')
    expect(list.style.left).toBe('120px')
    expect(list.style.top).toBe('244px')
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    expect(onRename).toHaveBeenCalledOnce()

    // The ungrouped bucket has no workspace verbs, so it keeps the platform menu.
    view.rerender(<ProjectRowItem seat={seatOf()}
      group={{ ...group, key: 'ungrouped', workspaceId: undefined, createdAt: undefined }}
      onToggle={onToggle} onCreate={vi.fn()} t={t}
    />)
    fireEvent.contextMenu(screen.getByRole('treeitem'), { button: 2, clientX: 10, clientY: 10 })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens the session row menu under the pointer and keeps a blank row menuless', () => {
    const onArchive = vi.fn()
    const node: SessionNode = {
      id: sid('one'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const view = render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={vi.fn()}
      onRename={vi.fn()} onFork={vi.fn()} onArchive={onArchive} t={t} />)
    fireEvent.contextMenu(screen.getByText('One'), { button: 2, clientX: 40, clientY: 60 })
    const list = screen.getByRole('menu')
    expect(list.style.left).toBe('40px')
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }))
    expect(onArchive).toHaveBeenCalledWith(sid('one'))

    // Reopening from the ... button drops the pointer anchor for the wrapper rect.
    fireEvent.click(screen.getByRole('button', { name: '会话“One”的操作' }), { detail: 1 })
    expect(screen.getByRole('menu').style.left).toBe('0px')

    view.rerender(<SessionNodeItem seat={seatOf()} node={{ ...node, blank: true }} currentId={undefined} now={0}
      onOpen={vi.fn()} onRename={vi.fn()} onFork={vi.fn()} onArchive={onArchive} t={t} />)
    fireEvent.contextMenu(screen.getByText('新会话'), { button: 2, clientX: 40, clientY: 60 })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('routes modified clicks to the selection and widens the menu to one bulk archive', () => {
    const onOpen = vi.fn()
    const onOne = vi.fn()
    const selection = {
      active: false, count: 0, archivableCount: 0,
      rowKey: 'session:row', seated: true, move: vi.fn(),
      extend: vi.fn(), toggle: vi.fn(), anchor: vi.fn(), archiveSelected: vi.fn(),
    }
    const node: SessionNode = {
      id: sid('one'), title: 'One', blank: false, running: false,
      runningSubagentCount: 0, completed: false, updatedAt: 0,
    }
    const view = render(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={onOpen}
      onRename={vi.fn()} onFork={vi.fn()} onArchive={onOne} selection={selection} t={t} />)
    const row = screen.getByText('One')
    fireEvent.click(row, { shiftKey: true })
    fireEvent.click(row, { metaKey: true })
    fireEvent.click(row, { ctrlKey: true })
    expect(selection.extend).toHaveBeenCalledOnce()
    expect(selection.toggle).toHaveBeenCalledTimes(2)
    expect(onOpen).not.toHaveBeenCalled()

    // A plain click anchors the range and still opens the session.
    fireEvent.click(row)
    expect(selection.anchor).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledWith(sid('one'))

    // Right-clicking outside the range narrows it to this row before opening.
    fireEvent.contextMenu(row, { button: 2, clientX: 8, clientY: 8 })
    expect(selection.anchor).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('menuitem', { name: '归档会话' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })

    // Inside a range of two or more, the per-row verbs give way to the bulk row.
    const ranged = { ...selection, active: true, count: 3, archivableCount: 3 }
    view.rerender(<SessionNodeItem seat={seatOf()} node={node} currentId={undefined} now={0} onOpen={onOpen}
      onRename={vi.fn()} onFork={vi.fn()} onArchive={onOne} selection={ranged} t={t} />)
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('treeitem').className).toMatch(/multiSelected/)
    fireEvent.contextMenu(screen.getByText('One'), { button: 2, clientX: 8, clientY: 8 })
    expect(ranged.anchor).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('menuitem', { name: '重命名' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 3 个会话' }))
    expect(ranged.archiveSelected).toHaveBeenCalledOnce()
    expect(onOne).not.toHaveBeenCalled()
  })
  it('routes modified clicks on a project row and widens its menu to the bulk archive', () => {
    const onToggle = vi.fn()
    const onRename = vi.fn()
    const selection = {
      active: false, count: 0, archivableCount: 0,
      rowKey: 'session:row', seated: true, move: vi.fn(),
      extend: vi.fn(), toggle: vi.fn(), anchor: vi.fn(), archiveSelected: vi.fn(),
    }
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Project',
      sessionCount: 2, expanded: false, containsCurrent: false, sessions: [],
      memberIds: [sid('one'), sid('two')],
    }
    const view = render(<ProjectRowItem seat={seatOf()}
      group={group} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: onRename, delete: vi.fn() }} selection={selection} t={t}
    />)
    const row = screen.getByText('Project')
    fireEvent.click(row, { shiftKey: true })
    fireEvent.click(row, { metaKey: true })
    expect(selection.extend).toHaveBeenCalledOnce()
    expect(selection.toggle).toHaveBeenCalledOnce()
    // A modified click edits the range instead of folding the group.
    expect(onToggle).not.toHaveBeenCalled()
    fireEvent.click(row)
    expect(selection.anchor).toHaveBeenCalledOnce()
    expect(onToggle).toHaveBeenCalledOnce()

    // A project range archives the sessions its projects hold, not the rows.
    const ranged = { ...selection, active: true, count: 2, archivableCount: 5 }
    view.rerender(<ProjectRowItem seat={seatOf()}
      group={group} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: onRename, delete: vi.fn() }} selection={ranged} t={t}
    />)
    expect(screen.getByRole('treeitem').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('treeitem').className).toMatch(/multiSelected/)
    fireEvent.contextMenu(screen.getByText('Project'), { button: 2, clientX: 4, clientY: 4 })
    expect(screen.queryByRole('menuitem', { name: '删除工作区' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: '归档选中的 5 个会话' }))
    expect(ranged.archiveSelected).toHaveBeenCalledOnce()
    expect(onRename).not.toHaveBeenCalled()
  })

  it('leaves the bulk row inert when a project range reaches no session', () => {
    const empty = {
      active: true, count: 2, archivableCount: 0,
      rowKey: 'session:row', seated: true, move: vi.fn(),
      extend: vi.fn(), toggle: vi.fn(), anchor: vi.fn(), archiveSelected: vi.fn(),
    }
    const group: GroupNode = {
      key: 'project', workspaceId: wid('project'), cwd: '/projects/project', createdAt: 0, label: 'Empty',
      sessionCount: 0, expanded: false, containsCurrent: false, sessions: [], memberIds: [],
    }
    const view = render(<ProjectRowItem seat={seatOf()}
      group={group} onToggle={vi.fn()} onCreate={vi.fn()}
      actions={{ rename: vi.fn(), delete: vi.fn() }} selection={empty} t={t}
    />)
    fireEvent.contextMenu(screen.getByText('Empty'), { button: 2, clientX: 4, clientY: 4 })
    const item = screen.getByRole('menuitem', { name: '归档选中的 0 个会话' })
    expect(item.hasAttribute('disabled')).toBe(true)
    fireEvent.click(item)
    expect(empty.archiveSelected).not.toHaveBeenCalled()

    // Two rows can still reach one session — the label counts sessions, not rows.
    view.rerender(<ProjectRowItem seat={seatOf()}
      group={{ ...group, memberIds: [sid('only')] }} onToggle={vi.fn()} onCreate={vi.fn()}
      actions={{ rename: vi.fn(), delete: vi.fn() }} selection={{ ...empty, archivableCount: 1 }} t={t}
    />)
    fireEvent.contextMenu(screen.getByText('Empty'), { button: 2, clientX: 4, clientY: 4 })
    expect(screen.getByRole('menuitem', { name: '归档选中的 1 个会话' }).hasAttribute('disabled')).toBe(false)
  })
})

/**
 * The keyboard reaches everything the pointer does: one tab stop per list, the
 * arrows inside it, the range gestures on Shift and Space, and the row menu on
 * the platform's own menu keys. Rows a range cannot select still walk and still
 * activate — they carry verbs of their own.
 */
describe('workspace rows keyboard', () => {
  /** A row's selection slice with every gesture recorded. */
  function account(overrides: Partial<RowMultiSelection> = {}): RowMultiSelection {
    return {
      active: false, count: 0, archivableCount: 0,
      extend: vi.fn(), toggle: vi.fn(), anchor: vi.fn(), archiveSelected: vi.fn(),
      ...overrides,
    }
  }

  /** A seat whose move is recorded. */
  function spiedSeat(overrides: Partial<RowSeat> = {}): RowSeat {
    return { rowKey: 'session:one', seated: true, level: 2, move: vi.fn(), ...overrides }
  }

  const session: SessionNode = {
    id: sid('one'), title: 'One', blank: false, running: false,
    runningSubagentCount: 0, completed: false, updatedAt: 0,
  }

  const project: GroupNode = {
    key: 'project', workspaceId: wid('project'), cwd: '/p', createdAt: 0, label: 'Project',
    sessionCount: 1, expanded: false, containsCurrent: false, sessions: [], memberIds: [sid('one')],
  }

  /** Render one session row over a seat and a selection slice; hand back the row. */
  function sessionRow(
    seat: RowSeat,
    selection: RowMultiSelection | undefined,
    onOpen = vi.fn(),
  ): HTMLElement {
    render(<SessionNodeItem seat={seat} node={session} currentId={undefined} now={0} onOpen={onOpen}
      onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()}
      {...selection === undefined ? {} : { selection }} t={t} />)
    return screen.getByRole('treeitem')
  }

  it("keeps one tab stop per list and reports each row's depth and key", () => {
    const seated = sessionRow(spiedSeat(), account())
    expect(seated.tabIndex).toBe(0)
    expect(seated.dataset['rowKey']).toBe('session:one')
    expect(seated.getAttribute('aria-level')).toBe('2')
    cleanup()
    expect(sessionRow(spiedSeat({ seated: false }), account()).tabIndex).toBe(-1)
  })

  it('walks a row no range can select and reports no selection state on it', () => {
    // The provisional blank draft has no row verbs, so no range reaches it; it
    // is still a node of the tree the arrows must walk and Enter must open.
    const seat = spiedSeat()
    const onOpen = vi.fn()
    render(<SessionNodeItem seat={seat} node={{ ...session, blank: true }} currentId={undefined} now={0}
      onOpen={onOpen} onRename={vi.fn()} onFork={vi.fn()} onArchive={vi.fn()} t={t} />)
    const blank = screen.getByRole('treeitem')
    expect(blank.tabIndex).toBe(0)
    expect(blank.getAttribute('aria-selected')).toBe('false')
    fireEvent.keyDown(blank, { key: 'ArrowDown' })
    expect(seat.move).toHaveBeenCalledWith('next', false)
    fireEvent.keyDown(blank, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(sid('one'))
    // The two selection keys go unanswered rather than acting on nothing.
    const space = createEvent.keyDown(blank, { key: ' ' })
    fireEvent(blank, space)
    expect(space.defaultPrevented).toBe(false)
    const shiftSpace = createEvent.keyDown(blank, { key: ' ', shiftKey: true })
    fireEvent(blank, shiftSpace)
    expect(shiftSpace.defaultPrevented).toBe(false)
  })

  it('omits selection state on a header no range can reach', () => {
    // `aria-selected="false"` on the Ungrouped bucket would promise a selection
    // it never takes; the row is still in the tab order for its own verbs.
    render(<ProjectRowItem seat={spiedSeat({ rowKey: 'bucket:ungrouped', level: 1 })}
      group={{ ...project, key: 'ungrouped', workspaceId: undefined, createdAt: undefined }}
      onToggle={vi.fn()} onCreate={vi.fn()} t={t} />)
    const bucket = screen.getByRole('treeitem')
    expect(bucket.hasAttribute('aria-selected')).toBe(false)
    expect(bucket.tabIndex).toBe(0)
    expect(bucket.getAttribute('aria-level')).toBe('1')
  })

  it("reaches the Ungrouped bucket's own verbs from the keyboard", () => {
    const onToggle = vi.fn()
    const seat = spiedSeat({ rowKey: 'bucket:ungrouped', level: 1 })
    render(<ProjectRowItem seat={seat}
      group={{ ...project, key: 'ungrouped', workspaceId: undefined, createdAt: undefined }}
      onToggle={onToggle} onCreate={vi.fn()} t={t} />)
    const bucket = screen.getByRole('treeitem')
    fireEvent.keyDown(bucket, { key: 'ArrowRight' })
    expect(onToggle).toHaveBeenCalledOnce()
    fireEvent.keyDown(bucket, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(bucket, { key: 'End' })
    expect(seat.move).toHaveBeenCalledWith('last', false)
  })

  it('moves the tab stop with the arrows and takes the range along on Shift', () => {
    const seat = spiedSeat()
    const row = sessionRow(seat, account())
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    fireEvent.keyDown(row, { key: 'ArrowUp', shiftKey: true })
    fireEvent.keyDown(row, { key: 'Home' })
    fireEvent.keyDown(row, { key: 'End', shiftKey: true })
    expect(vi.mocked(seat.move).mock.calls).toEqual([
      ['next', false], ['previous', true], ['first', false], ['last', true],
    ])
  })

  it('edits the selection on Space the way a modified click does', () => {
    const selection = account()
    const row = sessionRow(spiedSeat(), selection)
    fireEvent.keyDown(row, { key: ' ' })
    expect(selection.toggle).toHaveBeenCalledOnce()
    fireEvent.keyDown(row, { key: ' ', shiftKey: true })
    expect(selection.extend).toHaveBeenCalledOnce()
  })

  it('opens the session on Enter and anchors the range there, as a plain click does', () => {
    const selection = account()
    const onOpen = vi.fn()
    fireEvent.keyDown(sessionRow(spiedSeat(), selection, onOpen), { key: 'Enter' })
    expect(selection.anchor).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledWith(sid('one'))
  })

  it('leaves every other key to the browser', () => {
    const seat = spiedSeat()
    const selection = account()
    const row = sessionRow(seat, selection)
    const event = createEvent.keyDown(row, { key: 'a' })
    fireEvent(row, event)
    expect(event.defaultPrevented).toBe(false)
    expect(seat.move).not.toHaveBeenCalled()
    expect(selection.toggle).not.toHaveBeenCalled()
  })

  it('steps a session row out to the header it sits under', () => {
    const seat = spiedSeat()
    fireEvent.keyDown(sessionRow(seat, account()), { key: 'ArrowLeft' })
    expect(seat.move).toHaveBeenCalledWith('parent', false)
  })

  it("works a project row's disclosure with the horizontal arrows", () => {
    const seat = spiedSeat({ rowKey: 'workspace:project', level: 1 })
    const onToggle = vi.fn()
    const view = render(<ProjectRowItem seat={seat} group={project} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: vi.fn(), delete: vi.fn() }} selection={account()} t={t} />)
    const row = screen.getByRole('treeitem')
    // Folded: the opening arrow opens it and the closing arrow has nothing to do.
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    expect(onToggle).toHaveBeenCalledOnce()
    fireEvent.keyDown(row, { key: 'ArrowLeft' })
    expect(onToggle).toHaveBeenCalledOnce()

    // Open: the opening arrow steps into the first child, the closing one folds.
    view.rerender(<ProjectRowItem seat={seat} group={{ ...project, expanded: true }} onToggle={onToggle}
      onCreate={vi.fn()} actions={{ rename: vi.fn(), delete: vi.fn() }} selection={account()} t={t} />)
    const open = screen.getByRole('treeitem')
    fireEvent.keyDown(open, { key: 'ArrowRight' })
    expect(seat.move).toHaveBeenCalledWith('next', false)
    fireEvent.keyDown(open, { key: 'ArrowLeft' })
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it("routes a project row's remaining keys through the same account gestures", () => {
    const seat = spiedSeat({ rowKey: 'workspace:project', level: 1 })
    const selection = account()
    const onToggle = vi.fn()
    render(<ProjectRowItem seat={seat} group={project} onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: vi.fn(), delete: vi.fn() }} selection={selection} t={t} />)
    const row = screen.getByRole('treeitem')
    fireEvent.keyDown(row, { key: 'ArrowDown', shiftKey: true })
    expect(seat.move).toHaveBeenCalledWith('next', true)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(selection.anchor).toHaveBeenCalledOnce()
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('leaves a keystroke inside the row to the control that owns it', () => {
    const seat = spiedSeat()
    const selection = account()
    const onOpen = vi.fn()
    sessionRow(seat, selection, onOpen)
    const trailing = screen.getByRole('button', { name: '会话“One”的操作' })
    // The ... button answers Enter and Space itself, and the menu it opens is a
    // React child of the row, so both would otherwise reach the row's handler.
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowLeft']) {
      fireEvent.keyDown(trailing, { key })
    }
    expect(seat.move).not.toHaveBeenCalled()
    expect(selection.toggle).not.toHaveBeenCalled()
    expect(selection.anchor).not.toHaveBeenCalled()
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(trailing)
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'ArrowDown' })
    expect(seat.move).not.toHaveBeenCalled()
  })

  it("leaves a project row's keystrokes to the controls inside it too", () => {
    const selection = account()
    const onToggle = vi.fn()
    render(<ProjectRowItem seat={spiedSeat({ rowKey: 'workspace:project', level: 1 })} group={project}
      onToggle={onToggle} onCreate={vi.fn()}
      actions={{ rename: vi.fn(), delete: vi.fn() }} selection={selection} t={t} />)
    const create = screen.getByRole('button', { name: '在“Project”中新建会话' })
    for (const key of ['ArrowRight', 'ArrowLeft', 'Enter']) {
      fireEvent.keyDown(create, { key })
    }
    expect(onToggle).not.toHaveBeenCalled()
    expect(selection.anchor).not.toHaveBeenCalled()
  })

  it('opens the row menu against the row on the platform menu keys and hands it the focus', () => {
    const row = sessionRow(spiedSeat(), account())
    row.focus()
    // Shift+F10 and the ContextMenu key reach the row as a contextmenu event
    // with no pointer button behind it.
    fireEvent.contextMenu(row)
    const list = screen.getByRole('menu')
    expect(list.style.left).toBe('0px')
    expect(list.style.top).toBe('4px')
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0])

    // The arrows walk the list once the focus is inside it.
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[1])

    // Closing gives the focus back to the row it came from.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('has no row to hand the focus to when the whole list is inert', () => {
    const row = sessionRow(spiedSeat(), account({ active: true, count: 2, archivableCount: 0 }))
    row.focus()
    fireEvent.contextMenu(row)
    expect(screen.getByRole('menuitem').hasAttribute('disabled')).toBe(true)
    expect(document.activeElement).toBe(row)
  })

  it('opens against the row but keeps the focus when the row did not hold it', () => {
    // A touch long-press reaches the row as the same buttonless contextmenu the
    // keyboard sends, but its operator is not inside the list.
    const row = sessionRow(spiedSeat(), account())
    expect(document.activeElement).not.toBe(row)
    fireEvent.contextMenu(row)
    expect(screen.getByRole('menu').style.top).toBe('4px')
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves the focus alone when the pointer opened the list', () => {
    const row = sessionRow(spiedSeat(), account())
    row.focus()
    fireEvent.contextMenu(row, { button: 2, clientX: 40, clientY: 60 })
    expect(screen.getByRole('menu').style.left).toBe('40px')
    expect(document.activeElement).toBe(row)
  })
})
