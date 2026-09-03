/** Shared fixtures for the workspace-root panel specs. */

import { vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionWorkspaceOrigin, WorkspaceRootsProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh } from '../src/client/locales.ts'
import type { WorkspaceRootsActionProps, WorkspaceRootsInjected } from '../src/client/WorkspaceRootsAction.tsx'

/** Session the fixtures address. */
export const SESSION = 'roots-session' as SessionId
/** Primary root every fixture projection carries. */
export const PRIMARY = '/projects/primary'
/** Additional root the mutation fixtures add and remove. */
export const SECOND = '/projects/second'

/** Recorded injected-action calls, in call order. */
export interface RootsCalls {
  setRoots: { sessionId: SessionId; roots: readonly string[] }[]
  picks: number
  origins: number
}

/** One projection value plus the actions a spec wants to control. */
export interface RootsBench {
  /** The `workspaceRoots` value; `undefined` renders the loading placeholder. */
  roots?: WorkspaceRootsProjection | undefined
  /** Replacement outcome; defaults to accepting the requested set. */
  setRoots?: WorkspaceRootsInjected['setRoots']
  /** Chooser outcome; defaults to a cancelled chooser. */
  pickDirectory?: WorkspaceRootsInjected['pickDirectory']
  /** Origin read; defaults to a local backend. */
  loadOrigin?: WorkspaceRootsInjected['loadOrigin']
}

/**
 * Build a projection value.
 * @param additional - additional roots the Session recorded.
 * @param primary - primary root; null models a Session created without a cwd.
 * @returns the projection the component reads.
 */
export function projection(
  additional: readonly string[] = [],
  primary: string | null = PRIMARY,
): WorkspaceRootsProjection {
  return { primary, additional }
}

/**
 * Build the component props over one bench, recording every injected call.
 * @param bench - projection value and action overrides.
 * @returns the props plus the recorded-call ledger.
 */
export function props(bench: RootsBench = {}): {
  props: WorkspaceRootsActionProps
  calls: RootsCalls
} {
  const calls: RootsCalls = { setRoots: [], picks: 0, origins: 0 }
  const accept: WorkspaceRootsInjected['setRoots'] = (_sessionId, roots) =>
    Promise.resolve({ ok: true, value: { additional: [...roots] } })
  const injected: WorkspaceRootsInjected = {
    setRoots: (sessionId, roots) => {
      calls.setRoots.push({ sessionId, roots: [...roots] })
      return (bench.setRoots ?? accept)(sessionId, roots)
    },
    pickDirectory: () => {
      calls.picks += 1
      return (bench.pickDirectory ?? (() => Promise.resolve(null)))()
    },
    loadOrigin: () => {
      calls.origins += 1
      return (bench.loadOrigin ?? (() => Promise.resolve({ ok: true, value: origin('local') })))()
    },
  }
  const useProjection = vi.fn(() => bench.roots) as unknown as WorkspaceRootsActionProps['useProjection']
  return {
    props: {
      sessionId: SESSION,
      useProjection,
      ...injected,
      t: makeTranslate(zh),
    } as unknown as WorkspaceRootsActionProps,
    calls,
  }
}

/**
 * Build one origin value.
 * @param kind - the origin the deployment reports.
 * @returns the wire origin.
 */
export function origin(kind: string): SessionWorkspaceOrigin {
  return { kind }
}
