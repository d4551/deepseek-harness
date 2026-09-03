import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamTaskId, TeamTaskView as TeamTask, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh } from '../src/client/locales.ts'
import { TeamAction } from '../src/client/TeamAction.tsx'
import type {
  TeamActionInjected, TeamActionProps, TeamActionResult, TeamTaskActionResult,
} from '../src/client/TeamAction.tsx'

export { TeamAction }
export type { TeamActionInjected, TeamActionResult, TeamTaskActionResult }

export const SESSION = 'lead' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
export const TASK_2 = 'task-2' as TeamTaskId
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
  members: [
    { id: SESSION, name: 'lead', role: 'lead', status: 'idle', model: 'model-a', diagnostics: [] },
    {
      id: 'worker-id' as SessionId,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      model: 'model-a',
      diagnostics: [],
    },
  ],
  tasks: [task],
}

export function taskSuccess(value: TeamTask): TeamTaskActionResult {
  return { ok: true, value: { ok: true, value } }
}

export function taskConflict(message: string): TeamTaskActionResult {
  return {
    ok: true,
    value: { ok: false, error: { code: 'team-task-conflict', message } },
  }
}

export function taskRejected(message: string): TeamTaskActionResult {
  return {
    ok: true,
    value: { ok: false, error: { code: 'team-rejected', message } },
  }
}

export function remoteFailure(message: string): { ok: false; error: { code: 'internal'; message: string; details: {} } } {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

export function actions(overrides: Partial<TeamActionInjected> = {}): TeamActionInjected {
  return {
    load: () => Promise.resolve({ ok: true, value: view }),
    createTask: () => Promise.resolve(taskSuccess({ ...task, id: TASK_2, subject: 'New task' })),
    updateTask: () => Promise.resolve({
      ok: true,
      value: { ok: true, value: { ...task, revision: 2 } },
    }),
    openTeammate: () => Promise.resolve(),
    ...overrides,
  }
}

// The action reads none of the framework hooks; stub them as never-called so
// props() is a fully typed TeamActionProps with no widened cast.
const neverHook = (() => { throw new Error('TeamAction must not read framework hooks') }) as never

export function props(injected: TeamActionInjected, sessionId: SessionId = SESSION): TeamActionProps {
  return {
    sessionId,
    useSession: neverHook,
    useProjection: neverHook,
    useConversation: neverHook,
    useInput: neverHook,
    inputActions: neverHook,
    useSessions: neverHook,
    useSessionPendingInteraction: neverHook,
    useWorkspaces: neverHook,
    useChat: neverHook,
    useTrajectory: neverHook,
    t: makeTranslate(zh, commonZh),
    ...injected,
  }
}
