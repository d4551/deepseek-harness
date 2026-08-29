// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate, sessionSnapshot, workspaceSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkflowRunPanel, type WorkflowRunPanelProps } from '../src/client/WorkflowRunPanel.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const PARENT_ID = 'parent' as SessionId
const CHILD_ID = 'child-1' as SessionId

describe('workflow run panel accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for an empty running run', async () => {
    const sessions: SessionListState = {
      ids: [PARENT_ID, CHILD_ID],
      byId: {
        [PARENT_ID]: { id: PARENT_ID, displayTitle: 'parent', running: true, blank: false, updatedAt: 0 },
        [CHILD_ID]: { id: CHILD_ID, displayTitle: 'child', running: true, blank: false, updatedAt: 0 },
      },
      current: PARENT_ID,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    }
    const props = {
      node: {
        key: '12:workflow-runrun-1',
        kind: 'workflow-run',
        id: 'run-1',
        target: 'chat',
        anchorSeq: 3,
        location: { kind: 'unresolved' },
        visibility: 'visible',
        data: { name: 'empty', status: 'running', phases: [] },
      },
      sessionId: PARENT_ID,
      useSessions: (sel: (s: SessionListState) => unknown) => sel(sessions),
      useSessionPendingInteraction: (sel: (s: Map<SessionId, never>) => unknown) => sel(new Map<SessionId, never>()),
      useSession: (sel: (s: ReturnType<typeof sessionSnapshot>) => unknown) => sel(sessionSnapshot(PARENT_ID)),
      useProjection: () => undefined,
      useConversation: () => undefined,
      useChat: () => undefined,
      useTrajectory: () => undefined,
      useInput: () => { throw new Error('unused') },
      inputActions: {
        setDraft: () => {},
        addImages: () => false,
        removeImage: () => {},
        pruneImages: () => {},
        submit: () => {},
      },
      useWorkspaces: (sel: (s: ReturnType<typeof workspaceSnapshot>) => unknown) => sel(workspaceSnapshot()),
      useTurnData: () => undefined,
      openFile: () => {},
      inspectCall: () => {},
      forkAt: () => {},
      renderMessageImages: () => null,
      fileMentions: () => undefined,
      openSession: vi.fn(),
      t: makeTranslate(zh),
    } as WorkflowRunPanelProps
    const { baseElement } = render(createElement('main', null, createElement(WorkflowRunPanel, props)))
    expect(screen.getByRole('button', { name: /^empty/ })).toBeTruthy()
    expect(accessibilityFailures(
      [await auditSurface('WorkflowRunPanel', baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })
})
