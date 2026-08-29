// @vitest-environment jsdom
import { createElement, Fragment, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AppFrame } from '../src/client/AppFrame.tsx'
import type { AppFrameProps } from '../src/client/AppFrame.tsx'
import { createLayoutStore } from '../src/client/stores.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  window.innerWidth = 1920
})

const noAttention = new Map()
const useSessionPendingInteraction: AppFrameProps['useSessionPendingInteraction'] =
  selector => selector(noAttention)

function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

describe('app frame accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders no accessibility violations for the three-column shell', async () => {
    const instance = createLayoutStore().create()
    const current = 's-test' as SessionId
    const useSessions = ((sel: (s: SessionListState) => unknown) => sel({
      ids: [current],
      byId: {
        [current]: {
          id: current,
          displayTitle: 'Test',
          running: false,
          blank: false,
          updatedAt: 1,
          title: 'Test',
        },
      },
      current,
      phase: 'ready',
    } as SessionListState)) as AppFrameProps['useSessions']
    const workspace: WorkspaceSnapshot = {
      items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    }
    const frame = createElement(AppFrame, {
      useStore: hookOf(instance),
      actions: instance.actions,
      renderSlot: (key: string) => createElement('div', { 'data-testid': key }),
      useSessions,
      useSessionPendingInteraction,
      useWorkspaces: ((sel: (s: WorkspaceSnapshot) => unknown) => sel(workspace)) as AppFrameProps['useWorkspaces'],
      SessionProvider: ({ children }) => createElement(Fragment, null, children),
      t: key => key === 'brand.localBuild' ? 'DSH Local Build' : key,
    })
    const { baseElement } = render(createElement('main', null, frame))
    expect(accessibilityFailures(
      [await auditSurface('AppFrame', baseElement)],
      MINIMUM_ACCESSIBILITY_SCORE,
    )).toBe('')
  })
})
