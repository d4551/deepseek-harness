import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SubagentHeaderLineage } from '../src/client/SubagentHeaderLineage.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function unexpectedHook(): never {
  throw new Error('Subagent lineage must read only the session list')
}

it('exposes an accessible clickable trigger and child conversation tree', async () => {
  const parent = SessionId('parent')
  const child = SessionId('child')
  const state: SessionListState = {
    ids: [child],
    byId: {
      [child]: {
        id: child, title: '正在扫描项目文件', displayTitle: 'worker',
        running: true, blank: false, updatedAt: Date.now(),
      },
    },
    current: parent,
    phase: 'ready',
    subagentsByParent: {
      [parent]: {
        entries: [
          { kind: 'child', id: child, mode: 'continuable', label: 'worker', activity: 'running', hasChildren: true },
          { kind: 'child', id: SessionId('child-2'), mode: 'one-shot', label: 'reviewer', activity: 'inactive', hasChildren: false },
          { kind: 'diagnostic', id: SessionId('bad'), reason: 'corrupt' },
        ],
        parentAvailable: true, state: 'ready', error: null,
      },
    },
    jobsBySession: {},
    currentAddress: undefined,
  }
  const input = {
    sessionId: parent,
    lineageSessionId: parent,
    displayTitle: 'Parent title',
    useSessions: <T,>(select: (snapshot: SessionListState) => T): T => select(state),
    useSession: unexpectedHook,
    useProjection: unexpectedHook,
    useConversation: unexpectedHook,
    useInput: unexpectedHook,
    inputActions: {
      setDraft: unexpectedHook, addImages: unexpectedHook, removeImage: unexpectedHook,
      pruneImages: unexpectedHook, submit: unexpectedHook,
    },
    useSessionPendingInteraction: unexpectedHook,
    useWorkspaces: unexpectedHook,
    useChat: unexpectedHook,
    useTrajectory: unexpectedHook,
    openChild: vi.fn(),
    refresh: vi.fn(),
    setCatalogOpen: vi.fn(),
    t: makeTranslate(zh),
  }
  render(<SubagentHeaderLineage {...input} />)
  const trigger = screen.getByRole('button', { name: /2 个子代理/ })
  fireEvent.click(trigger)
  const audits = [
    await auditSurface('subagent trigger', trigger),
    await auditSurface('subagent conversations', screen.getByRole('tree')),
  ]
  expect(audits.flatMap(audit => audit.undecidedRules)).toEqual([])
  expect(accessibilityFailures(audits, 100)).toBe('')
})
