import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamTaskView as TeamTask, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh } from '../src/client/locales.ts'
import { TeamAction } from '../src/client/TeamAction.tsx'
import { TeamTaskId } from '../../../subagent/agent-team/src/types.ts'
import type {
  TeamActionInjected, TeamActionProps, TeamActionResult,
} from '../src/client/TeamAction.tsx'

export { TeamAction }
export type { TeamActionInjected, TeamActionResult }

export const SESSION = SessionId('lead')
const TASK_1 = TeamTaskId('task-1')
export const TASK_2 = TeamTaskId('task-2')
export const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
export const view: TeamView = {
  workspaceTasks: [],
  subagents: [],
  messages: [],
  members: [
    { id: SESSION, name: 'lead', role: 'lead', status: 'idle', model: 'model-a', diagnostics: [] },
    {
      id: SessionId('worker-id'),
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      model: 'model-a',
      diagnostics: [],
    },
  ],
  tasks: [task],
}

export function remoteFailure(message: string): { ok: false; error: { code: 'internal'; message: string; details: {} } } {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

export function actions(overrides: Partial<TeamActionInjected> = {}): TeamActionInjected {
  return {
    changes: async function* (_sessionId, signal) {
      signal.throwIfAborted()
      yield 0
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
    load: () => Promise.resolve({ ok: true, value: view }),
    loadConversations: () => Promise.resolve({ ok: true, value: view.subagents }),
    openTeammate: () => Promise.reject(new Error('Test must supply teammate navigation')),
    openSubagent: () => Promise.reject(new Error('Test must supply subagent navigation')),
    ...overrides,
  }
}

function neverHook(): never {
  throw new Error('TeamAction must not read framework hooks')
}

export function props(injected: TeamActionInjected, sessionId: SessionId = SESSION): TeamActionProps {
  return {
    sessionId,
    useSession: neverHook,
    useProjection: neverHook,
    useConversation: neverHook,
    useInput: neverHook,
    inputActions: {
      setDraft: neverHook,
      addImages: neverHook,
      removeImage: neverHook,
      pruneImages: neverHook,
      submit: neverHook,
    },
    useSessions: neverHook,
    useSessionPendingInteraction: neverHook,
    useWorkspaces: neverHook,
    useChat: neverHook,
    useTrajectory: neverHook,
    t: makeTranslate(zh, commonZh),
    ...injected,
  }
}
