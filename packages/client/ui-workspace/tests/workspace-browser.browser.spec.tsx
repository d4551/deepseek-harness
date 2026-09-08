import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createWorkspaceViewStore } from '../src/client/stores.ts'
import { WorkspaceBrowser } from '../src/client/rows/WorkspaceBrowser.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

function unexpectedAction(): never {
  throw new Error('Navigation audit must not mutate workspace data')
}

it('audits the assembled grouped tree and search results', async () => {
  const items: SessionSummary[] = Array.from({ length: 7 }, (_, index) => ({
    id: SessionId(`session-${index + 1}`), displayTitle: `session-${index + 1}`,
    running: false, blank: false, updatedAt: 7 - index,
  }))
  const sessions: SessionListState = {
    ids: items.map(item => item.id), byId: Object.fromEntries(items.map(item => [item.id, item])),
    current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  function workspace(id: string, members: SessionSummary[]): WorkspaceView {
    return {
      workspaceId: WorkspaceId(id), path: `/projects/${id}`, title: id,
      sessionIds: members.map(item => item.id),
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }
  const workspaces: WorkspaceSnapshot = {
    items: [workspace('alpha', items.slice(0, 6)), workspace('beta', items.slice(6))],
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }
  const store = createWorkspaceViewStore().create()
  store.actions.setOrderBy('manual')
  const searchSessions = vi.fn(async () => ({ items: [], hasMore: false }))
  const { baseElement } = render(<main><WorkspaceBrowser
    wide expandSidebar={unexpectedAction}
    useSessions={select => select(sessions)}
    useSessionPendingInteraction={select => select(new Map())}
    useWorkspaces={select => select(workspaces)}
    useStore={bindSnapshotSelector(store)} actions={store.actions}
    startSession={unexpectedAction} open={unexpectedAction}
    searchSessions={searchSessions} searchResultLimit={20}
    renameSession={unexpectedAction} forkSession={unexpectedAction}
    renameWorkspace={unexpectedAction} deleteWorkspace={unexpectedAction}
    archiveSession={unexpectedAction} insertWorkspaceBefore={unexpectedAction}
    insertSessionBefore={unexpectedAction} createWorkspace={unexpectedAction}
    useDirectoryFlow={select => select(true)}
    useConnectionGeneration={select => select(undefined)}
    renderSlot={(_key, owner) => {
      if (typeof owner === 'object' && owner !== null && 'open' in owner && owner.open === false) return null
      return unexpectedAction()
    }}
    t={makeTranslate(zh, commonZh)}
  /></main>)
  fireEvent.click(screen.getByText('alpha'))
  const audits = [await auditSurface('WorkspaceBrowser grouped tree', baseElement)]
  fireEvent.click(screen.getByRole('button', { name: '搜索会话' }))
  fireEvent.change(screen.getByPlaceholderText('搜索会话…'), { target: { value: 'session' } })
  await waitFor(() => { expect(searchSessions).toHaveBeenCalled() })
  audits.push(await auditSurface('WorkspaceBrowser search results', baseElement))
  for (const audit of audits) {
    expect(audit.passed + audit.failed, `${audit.surface} decided no checks`).toBeGreaterThan(0)
    expect(audit.undecidedRules).toEqual([])
  }
  expect(accessibilityFailures(audits, 100)).toBe('')
})
