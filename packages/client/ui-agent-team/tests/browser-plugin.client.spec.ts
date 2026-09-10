import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  TeamMemberView as TeamRosterMember,
  TeamTaskId,
  TeamTaskView,
  TeamView,
} from '@deepseek-ai/dsh-agent-team/client'
import type {} from '@deepseek-ai/dsh-agent-team/remote'
import type { RemoteFailure, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {
  TeamAction,
  type TeamActionInjected,
  type TeamActionResult,
} from '../src/client/TeamAction.tsx'
import { inject, mountAgentTeamUi } from '../src/client/mount.ts'
import { apply as nodeApply } from '../src/index.ts'
import { TeamActivity } from '../../../subagent/agent-team/src/activity.ts'
import { TeamId } from '../../../subagent/agent-team/src/types.ts'

const SESSION = 'team-session' as SessionId
const CHILD = 'team-child' as SessionId
const TASK_ID = 'task-1' as TeamTaskId
const REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-agent-team',
  descriptors: [],
}

type TeamRpcCall =
  | { method: 'agentTeams/changes'; args: [sessionId: SessionId] }
  | { method: 'agentTeams/overview'; args: [sessionId: SessionId] }
  | { method: 'agentTeams/conversations'; args: [sessionId: SessionId] }

interface TeamAddress {
  parentSessionId: SessionId
  childSessionId: SessionId
  mode: 'continuable'
}

type TeamNavigation = ['refresh', SessionId] | ['open', TeamAddress] | ['select', SessionId]

const isTeamActionInjected = <T extends object>(value: T): value is T & TeamActionInjected =>
  'changes' in value && 'load' in value && 'loadConversations' in value && 'openTeammate' in value

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
  workspaceTasks: [],
  subagents: [],
  messages: [],
  members: [{
    id: SESSION, name: 'lead', role: 'lead', status: 'idle', diagnostics: [],
  }],
  tasks: [TASK],
}

async function bench(options: {
  addressed?: boolean
  registrationFailure?: boolean
  remoteFailure?: 'view'
  refreshGate?: Promise<void>
  parents?: ReadonlyMap<SessionId, SessionId>
  current?: SessionId
} = {}) {
  const ctx = new Context()
  const calls: TeamRpcCall[] = []
  const activity = new TeamActivity()
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
  ctx.provide('remote.agentTeams', {
    changes: (sessionId: SessionId, signal: AbortSignal): AsyncIterable<number> => {
      calls.push({ method: 'agentTeams/changes', args: [sessionId] })
      return activity.changes(TeamId(sessionId), signal)
    },
    overview: (sessionId: SessionId): Promise<TeamActionResult<TeamView>> => {
      calls.push({ method: 'agentTeams/overview', args: [sessionId] })
      return Promise.resolve(options.remoteFailure === 'view'
        ? CARRIER_FAILURE
        : { ok: true as const, value: VIEW })
    },
    conversations: (sessionId: SessionId): Promise<TeamActionResult<TeamView['subagents']>> => {
      calls.push({ method: 'agentTeams/conversations', args: [sessionId] })
      return Promise.resolve({ ok: true, value: VIEW.subagents })
    },
  })
  const navigation: TeamNavigation[] = []
  let current = options.current ?? (options.addressed === true ? CHILD : SESSION)
  const parentOf = (id: SessionId): SessionId | undefined =>
    options.parents?.get(id) ?? (options.addressed === true && id === CHILD ? SESSION : undefined)
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ current, byId: {} }) },
    binding: (id: SessionId) => parentOf(id) !== undefined
      ? { session: { getSnapshot: () => ({
        subagent: {
          address: {
            parentSessionId: parentOf(id),
            childSessionId: id,
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
    open: (id: SessionId) => { navigation.push(['select', id]) },
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
  it('registers one disposable read-only header action with live Remote observations', async () => {
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
    expect('createTask' in actions).toBe(false)
    expect('updateTask' in actions).toBe(false)
    expect((await actions.loadConversations(SESSION, new AbortController().signal)).ok).toBe(true)
    expect(b.calls.map(call => call.method)).toEqual([
      'agentTeams/overview', 'agentTeams/conversations',
    ])

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

  it('returns Remote carrier failures unchanged', async () => {
    const view = await bench({ remoteFailure: 'view' })
    await expect(view.actions().load(SESSION)).resolves.toEqual({
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
    const controller = new AbortController()
    const changes = actions.changes(CHILD, controller.signal)[Symbol.asyncIterator]()
    expect(await changes.next()).toEqual({ value: 0, done: false })
    expect(b.calls[0]).toEqual({ method: 'agentTeams/changes', args: [SESSION] })
    controller.abort()
    expect(await changes.next()).toEqual({ value: undefined, done: true })
    await actions.load(CHILD)
    await actions.openTeammate(CHILD, {
      id: CHILD,
      name: 'worker',
      role: 'teammate',
      status: 'inactive',
      diagnostics: [],
    })
    expect(b.calls[1]).toEqual({ method: 'agentTeams/overview', args: [SESSION] })
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

  it('resolves nested Team conversations to their Lead and opens exact child addresses', async () => {
    const nested = SessionId('nested-worker')
    const b = await bench({ current: nested, parents: new Map([[nested, CHILD], [CHILD, SESSION]]) })
    await b.actions().load(nested)
    expect(b.calls).toEqual([{ method: 'agentTeams/overview', args: [SESSION] }])
    await b.actions().loadConversations(nested, new AbortController().signal)
    expect(b.calls[1]).toEqual({ method: 'agentTeams/conversations', args: [SESSION] })
    const lead = VIEW.members[0]
    if (lead === undefined) throw new Error('Team test requires its Lead')
    await b.actions().openTeammate(nested, lead)
    expect(b.navigation).toEqual([['select', SESSION]])
    await b.actions().openSubagent(nested, {
      kind: 'child', id: nested, parentId: CHILD, depth: 2,
      mode: 'continuable', label: 'Nested worker', activity: 'inactive', hasChildren: false,
    })
    expect(b.navigation.slice(1)).toEqual([
      ['refresh', CHILD], ['open', { parentSessionId: CHILD, childSessionId: nested, mode: 'continuable' }],
    ])
    await b.fiber.dispose()
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
