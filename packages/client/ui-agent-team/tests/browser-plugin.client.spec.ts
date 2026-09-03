import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  TeamMemberView as TeamRosterMember,
  TeamTaskId,
  TeamTaskMutationResult,
  TeamTaskView,
  TeamView,
} from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-agent-team/remote'
import type { RemoteFailure, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {
  TeamAction,
  type TeamActionInjected,
  type TeamActionResult,
  type TeamTaskActionResult,
} from '../src/client/TeamAction.tsx'
import { inject, mountAgentTeamUi } from '../src/client/mount.ts'
import { apply as nodeApply } from '../src/index.ts'

const SESSION = 'team-session' as SessionId
const CHILD = 'team-child' as SessionId
const TASK_ID = 'task-1' as TeamTaskId
const REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-agent-team',
  descriptors: [],
}

type CreateTaskInput = Parameters<TeamActionInjected['createTask']>[1]
type UpdateTaskInput = Parameters<TeamActionInjected['updateTask']>[1]

type TeamRpcCall =
  | { method: 'agentTeams/view'; args: [sessionId: SessionId] }
  | { method: 'agentTeams/createTask'; args: [sessionId: SessionId, input: CreateTaskInput] }
  | { method: 'agentTeams/updateTask'; args: [sessionId: SessionId, input: UpdateTaskInput] }

interface TeamAddress {
  parentSessionId: SessionId
  childSessionId: SessionId
  mode: 'continuable'
}

type TeamNavigation = ['refresh', SessionId] | ['open', TeamAddress]

const isTeamActionInjected = <T extends object>(value: T): value is T & TeamActionInjected =>
  'load' in value && 'createTask' in value && 'updateTask' in value && 'openTeammate' in value

const TASK: TeamTaskView = {
  id: TASK_ID,
  revision: 1,
  subject: 'Task',
  description: 'Description',
  status: 'pending',
  blockedBy: [],
  writeScopes: [],
  ready: true,
  writeScopeWarnings: [],
}

const FAILURE: RemoteFailure = {
  code: 'internal',
  message: 'offline',
  details: {},
}

const CARRIER_FAILURE: TeamActionResult<never> = {
  ok: false,
  error: FAILURE,
}

const VIEW: TeamView = {
  members: [{
    id: SESSION, name: 'lead', role: 'lead', status: 'idle', diagnostics: [],
  }],
  tasks: [TASK],
}

async function bench(options: {
  addressed?: boolean
  conflict?: boolean
  registrationFailure?: boolean
  remoteFailure?: 'view' | 'update'
  refreshGate?: Promise<void>
} = {}) {
  const ctx = new Context()
  const calls: TeamRpcCall[] = []
  class RemoteService extends Service {
    readonly disposeMount = vi.fn(() => Promise.resolve())
    readonly mount = vi.fn((_contribution: TypertRemoteContribution) => Promise.resolve(this.disposeMount))

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
      return this.mount(contribution)
    }
  }
  const remote = new RemoteService(ctx)
  const mutation = (value: TeamTaskMutationResult): RemoteResult<TeamTaskMutationResult> =>
    ({ ok: true as const, value })
  ctx.provide('remote.agentTeams', {
    view: (sessionId: SessionId): Promise<TeamActionResult<TeamView>> => {
      calls.push({ method: 'agentTeams/view', args: [sessionId] })
      return Promise.resolve(options.remoteFailure === 'view'
        ? CARRIER_FAILURE
        : { ok: true as const, value: VIEW })
    },
    createTask: (sessionId: SessionId, input: CreateTaskInput): Promise<TeamTaskActionResult> => {
      calls.push({ method: 'agentTeams/createTask', args: [sessionId, input] })
      return Promise.resolve(mutation({ ok: true as const, value: TASK }))
    },
    updateTask: (sessionId: SessionId, input: UpdateTaskInput): Promise<TeamTaskActionResult> => {
      calls.push({ method: 'agentTeams/updateTask', args: [sessionId, input] })
      if (options.remoteFailure === 'update') return Promise.resolve(CARRIER_FAILURE)
      return Promise.resolve(mutation(options.conflict
        ? {
          ok: false as const,
          error: { code: 'team-task-conflict' as const, message: 'stale' },
        }
        : { ok: true as const, value: { ...TASK, revision: 2 } }))
    },
  })
  const navigation: TeamNavigation[] = []
  let current = options.addressed === true ? CHILD : SESSION
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ current }) },
    binding: (id: SessionId) => options.addressed === true && id === CHILD
      ? { session: { getSnapshot: () => ({
        subagent: {
          address: {
            parentSessionId: SESSION,
            childSessionId: CHILD,
            mode: 'continuable' as const,
          },
        },
      }) } }
      : undefined,
    refreshSubagents: (id: SessionId) => {
      navigation.push(['refresh', id])
      return options.refreshGate ?? Promise.resolve()
    },
    openSubagent: (address: TeamAddress) => { navigation.push(['open', address]) },
  })
  ctx.provide('conversation', {})
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const collapseHeader = ctx.slots.register({
    name: 'root',
    children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  if (options.registrationFailure === true) {
    vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot registration failed') })
  }
  const fiber = options.registrationFailure === true
    ? ctx.plugin({ apply: () => Promise.resolve() })
    : ctx.plugin({ inject: [...inject], apply: clientCtx => mountAgentTeamUi(clientCtx, REMOTE) })
  const activation: Promise<Error | null> = options.registrationFailure === true
    ? Promise.allSettled([mountAgentTeamUi(ctx, REMOTE)]).then(([outcome]): Error | null => outcome.status === 'rejected'
      ? (outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)))
      : null)
    : fiber.await().then(() => null)
  await fiber.await()
  if (options.registrationFailure !== true) {
    await activation
  }
  const entry = () => ctx.slots.entries('conversation.session.header.actions')
    .find(candidate => candidate.component === TeamAction)
  const actions = (): TeamActionInjected => {
    const injected = entry()?.inject?.()
    if (injected === undefined || !isTeamActionInjected(injected)) {
      throw new Error('TeamAction inject face is missing from the header slot')
    }
    return injected
  }
  return {
    ctx,
    fiber,
    activation,
    calls,
    navigation,
    remote,
    entry,
    actions,
    collapseHeader,
    select: (sessionId: SessionId) => { current = sessionId },
  }
}

describe('ui-team browser plugin', () => {
  it('registers one disposable header action with RPC-backed task operations', async () => {
    const b = await bench()
    expect(inject).toEqual(['sessions', 'remote', 'slots', 'locale'])
    expect(b.entry()).toMatchObject({
      options: { id: 'agent-team', order: 20 },
      locale: 'agent-team',
    })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.remote.mount).toHaveBeenCalledWith(REMOTE)
    const actions = b.actions()
    expect((await actions.load(SESSION)).ok).toBe(true)
    expect((await actions.createTask(SESSION, {
      subject: 'Task', description: 'Description', blockedBy: [], writeScopes: [],
    })).ok).toBe(true)
    expect((await actions.updateTask(SESSION, {
      taskId: TASK_ID, expectedRevision: 1, action: 'complete',
    })).ok).toBe(true)
    expect((await actions.updateTask(SESSION, {
      taskId: TASK_ID, expectedRevision: 2, action: 'reassign', owner: 'worker',
    })).ok).toBe(true)
    expect(b.calls.map(call => call.method)).toEqual([
      'agentTeams/view', 'agentTeams/createTask', 'agentTeams/updateTask', 'agentTeams/updateTask',
    ])
    expect(b.calls.at(-1)?.args[1]).toMatchObject({ owner: 'worker' })

    await actions.openTeammate(SESSION, {
      id: SESSION,
      name: 'lead',
      role: 'lead',
      status: 'idle',
      diagnostics: [],
    })
    expect(b.navigation).toEqual([])

    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.remote.disposeMount).toHaveBeenCalledOnce()
  })

  it('unmounts the Remote contribution when later Client registration fails', async () => {
    const b = await bench({ registrationFailure: true })
    await expect(b.activation).resolves.toMatchObject({ message: 'slot registration failed' })
    expect(b.remote.mount).toHaveBeenCalledOnce()
    expect(b.remote.disposeMount).toHaveBeenCalledOnce()
  })

  it('returns the generated task business result without a Client transport envelope', async () => {
    const b = await bench({ conflict: true })
    await expect(b.actions().updateTask(SESSION, {
      taskId: TASK_ID, expectedRevision: 1, action: 'delete',
    })).resolves.toEqual({
      ok: true,
      value: {
        ok: false,
        error: { code: 'team-task-conflict', message: 'stale' },
      },
    })
  })

  it('returns Remote carrier failures unchanged', async () => {
    const view = await bench({ remoteFailure: 'view' })
    await expect(view.actions().load(SESSION)).resolves.toEqual({
      ok: false,
      error: { code: 'internal', message: 'offline', details: {} },
    })

    const update = await bench({ remoteFailure: 'update' })
    await expect(update.actions().updateTask(SESSION, {
      taskId: TASK_ID, expectedRevision: 1, action: 'delete',
    })).resolves.toEqual({
      ok: false,
      error: { code: 'internal', message: 'offline', details: {} },
    })
  })

  it('refreshes the descriptor catalog before opening a continuable teammate address', async () => {
    const b = await bench()
    const member: TeamRosterMember = {
      id: CHILD,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      diagnostics: [],
    }
    await b.actions().openTeammate(SESSION, member)
    expect(b.navigation).toEqual([
      ['refresh', SESSION],
      ['open', {
        parentSessionId: SESSION,
        childSessionId: CHILD,
        mode: 'continuable',
      }],
    ])
  })

  it('routes Team actions from an addressed teammate conversation back through its Lead', async () => {
    const b = await bench({ addressed: true })
    const actions = b.actions()
    await actions.load(CHILD)
    await actions.openTeammate(CHILD, {
      id: CHILD,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      diagnostics: [],
    })
    expect(b.calls[0]).toEqual({ method: 'agentTeams/view', args: [SESSION] })
    expect(b.navigation).toEqual([
      ['refresh', SESSION],
      ['open', {
        parentSessionId: SESSION,
        childSessionId: CHILD,
        mode: 'continuable',
      }],
    ])
  })

  it('does not open a teammate after navigation switches during catalog refresh', async () => {
    const refresh = Promise.withResolvers<undefined>()
    const b = await bench({ refreshGate: refresh.promise })
    const opening = b.actions().openTeammate(SESSION, {
      id: CHILD,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      diagnostics: [],
    })
    expect(b.navigation).toEqual([['refresh', SESSION]])
    b.select('other-session' as SessionId)
    refresh.resolve(undefined)
    await opening
    expect(b.navigation).toEqual([['refresh', SESSION]])
  })

  it('re-registers after the conversation header slot is collapsed and declared again', async () => {
    const b = await bench()
    expect(b.entry()).toBeDefined()
    b.collapseHeader()
    expect(b.entry()).toBeUndefined()
    b.ctx.slots.register({
      name: 'root',
      children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(b.entry()).toBeDefined()
  })

  it('keeps the node half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
