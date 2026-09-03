import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type {
  AgentContext,
  ISessions,
  SessionBinding,
  SessionListState,
  SessionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Fragment } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, UiSession } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import * as SessionInvariant from '../src/invariant.ts'

interface SessionsBench {
  readonly sessions: ISessions
  readonly list: ReturnType<typeof createSnapshotStore<SessionListState>>
  readonly resolveBinding: ReturnType<typeof vi.fn<(id: SessionId) => SessionBinding | undefined>>
  readonly createSession: ReturnType<typeof vi.fn<ISessions['create']>>
  readonly openSession: ReturnType<typeof vi.fn<(id: SessionId) => void>>
  readonly clearSession: ReturnType<typeof vi.fn<() => void>>
  binding(id: SessionId): SessionBinding
  select(id: SessionId | undefined): void
  release(id: SessionId): Promise<void>
}

const sessionId = (value: string): SessionId => value as SessionId

function createSessionsBench(_ctx: Context): SessionsBench {
  const list = createSnapshotStore<SessionListState>({
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const bindings = new Map<SessionId, SessionBinding>()
  const scopes = new Map<SessionId, Context>()
  const resolveBinding = vi.fn((id: SessionId) => bindings.get(id))
  const createSession = vi.fn<ISessions['create']>(async options =>
    options?.sessionId ?? sessionId(`created-${String(options?.workspaceId ?? 'none')}`))
  const openSession = vi.fn((id: SessionId) => {
    list.update((draft) => { draft.current = id })
  })
  const clearSession = vi.fn(() => {
    list.update((draft) => { draft.current = undefined })
  })
  const sessions = {
    list,
    create: createSession,
    open: openSession,
    clear: clearSession,
    binding: resolveBinding,
  } as unknown as ISessions

  return {
    sessions,
    list,
    resolveBinding,
    createSession,
    openSession,
    clearSession,
    binding(id) {
      const scopeCtx = new Context()
      const snapshot = createSnapshotStore<SessionSnapshot>({
        sessionId: id,
        queue: [],
        pendingSubmissions: [],
        running: false,
        subagent: null,
        removed: false,
        openState: 'open',
        openError: null,
        hasMore: false,
        loadingOlder: false,
        promptError: null,
        blank: false,
        lastAgentError: null,
        promptAttempted: false,
        awaitingFirstTurn: false,
      })
      const projections = new Map<string, HostObservable<unknown>>()
      const session = {
        sessionId: id,
        projections: {
          faceOf(key: string) {
            let source = projections.get(key)
            if (source === undefined) {
              source = createSnapshotStore<unknown>(undefined)
              projections.set(key, source)
            }
            return source
          },
        },
        getSnapshot: () => snapshot.getSnapshot(),
        subscribe: (listener: () => void) => snapshot.subscribe(listener),
      } as unknown as SessionBinding['session']
      const binding: SessionBinding = {
        sessionId: id,
        session,
        eventSource: new MutableSessionEventSource(),
        ctx: scopeCtx as AgentContext,
      }
      bindings.set(id, binding)
      scopes.set(id, scopeCtx)
      list.update((draft) => {
        if (!draft.ids.includes(id)) draft.ids.push(id)
        draft.byId[id] = {
          id,
          displayTitle: id,
          running: false,
          blank: false,
          updatedAt: 1,
        }
      })
      return binding
    },
    select(id) {
      list.update((draft) => { draft.current = id })
    },
    async release(id) {
      bindings.delete(id)
      const scopeCtx = scopes.get(id)
      scopes.delete(id)
      await scopeCtx?.fiber.dispose()
    },
  }
}

function createUiSession(ctx: Context, bench: SessionsBench): UiSession {
  ctx.provide('slots', { bindStoreScope: vi.fn() } as never)
  return new UiSession(ctx, bench.sessions)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('UiSession bindings', () => {
  it('binds each materialized Session to renderer-owned Store cleanup', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const bindStoreScope = vi.fn()
    ctx.provide('slots', { bindStoreScope } as never)
    const service = new UiSession(ctx, bench.sessions)
    const binding = bench.binding(sessionId('s1'))

    const materialized = service.adapter.resolve(binding.sessionId)

    expect(bindStoreScope).toHaveBeenCalledOnce()
    expect(bindStoreScope).toHaveBeenCalledWith(materialized)
  })

  it('materializes built-in sources, caches a binding, and publishes selection and release', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const id = sessionId('s1')
    const binding = bench.binding(id)
    const current = vi.fn()
    const offCurrent = service.adapter.current.subscribe(current)

    expect(service.adapter.current.getSnapshot()).toEqual({
      key: undefined,
      hooks: { session: undefined },
      keyedHooks: { projection: undefined },
      props: { sessionId: undefined },
    })
    expect(service.adapter.resolve('missing')).toBeUndefined()

    const first = service.adapter.resolve(id)!
    expect(service.adapter.resolve(id)).toBe(first)
    expect(first.key).toBe(id)
    expect(first.hooks.session).toBe(binding.session)
    expect(first.props.sessionId).toBe(id)
    expect(first.keyedHooks.projection?.('status'))
      .toBe(binding.session.projections.faceOf('status'))

    bench.select(id)
    expect(current).toHaveBeenCalledTimes(1)
    expect(service.adapter.current.getSnapshot()).toBe(first)
    bench.select(id)
    expect(current).toHaveBeenCalledTimes(1)

    bench.resolveBinding.mockClear()
    await bench.release(id)
    expect(bench.resolveBinding).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledTimes(2)
    expect(service.adapter.current.getSnapshot().key).toBeUndefined()

    const other = sessionId('s2')
    bench.binding(other)
    service.adapter.resolve(other)
    bench.resolveBinding.mockClear()
    await bench.release(other)
    expect(bench.resolveBinding).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledTimes(2)

    offCurrent()
    await ctx.fiber.dispose()
  })

  it('renders the empty area and a Session-keyed selected area', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const empty = vi.fn(() => 'empty')
    const children = 'session body'
    if (service.adapter.renderArea === undefined) throw new Error('Session area renderer was not installed')

    const emptyArea = service.adapter.renderArea(
      service.adapter.current.getSnapshot(),
      { empty, children },
    )
    expect(emptyArea).toMatchObject({
      type: Fragment,
      key: null,
      props: { children: 'empty' },
    })
    expect(empty).toHaveBeenCalledOnce()

    const defaultEmptyArea = service.adapter.renderArea(
      service.adapter.current.getSnapshot(),
      { children },
    )
    expect(defaultEmptyArea).toMatchObject({
      type: Fragment,
      key: null,
      props: { children: null },
    })

    const id = sessionId('s1')
    bench.binding(id)
    bench.select(id)
    const selectedArea = service.adapter.renderArea(
      service.adapter.current.getSnapshot(),
      { empty, children },
    )
    expect(selectedArea).toMatchObject({
      type: Fragment,
      key: id,
      props: { children },
    })
    expect(empty).toHaveBeenCalledOnce()
  })

  it('contains a failing current-binding subscriber and continues dispatch', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const id = sessionId('s1')
    bench.binding(id)
    const failure = new Error('subscriber failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.adapter.current.subscribe(() => { throw failure })
    const after = vi.fn()
    service.adapter.current.subscribe(after)

    bench.select(id)

    expect(after).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(
      '[ui-session] current binding subscriber failed:',
      failure,
    )
  })

  it('releases cached bindings when the owning Client context stops', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const id = sessionId('s1')
    bench.binding(id)
    bench.select(id)
    service.adapter.current.getSnapshot()

    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
    await bench.release(id)
  })

  it('rebuilds live bindings and removes only the disposed source contribution', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const id = sessionId('s1')
    bench.binding(id)
    bench.select(id)
    const custom = createSnapshotStore({ value: 1 })
    const keyed = (key: string): HostObservable<unknown> => createSnapshotStore(key)

    const dispose = service.provide({
      hooks: ['custom'],
      keyedHooks: ['customKeyed'],
      props: ['customProp'],
      resolve: () => ({
        hooks: { custom },
        keyedHooks: { customKeyed: keyed },
        props: { customProp: 'value' },
      }),
    })
    const disposeNeighbor = service.provide({
      props: ['neighborProp'],
      resolve: () => ({ props: { neighborProp: 'neighbor' } }),
    })

    const contributed = service.adapter.current.getSnapshot()
    expect(contributed.hooks.custom).toBe(custom)
    expect(contributed.keyedHooks.customKeyed).toBe(keyed)
    expect(contributed.props.customProp).toBe('value')
    expect(contributed.props.neighborProp).toBe('neighbor')

    dispose()
    const restored = service.adapter.current.getSnapshot()
    expect(restored.hooks.session).toBeDefined()
    expect(typeof restored.keyedHooks.projection).toBe('function')
    expect(restored.props.sessionId).toBe(id)
    expect(restored.hooks).not.toHaveProperty('custom')
    expect(restored.props.neighborProp).toBe('neighbor')
    dispose()
    expect(service.adapter.current.getSnapshot().props.neighborProp).toBe('neighbor')

    disposeNeighbor()
    expect(service.adapter.current.getSnapshot().props).not.toHaveProperty('neighborProp')
  })

  it.each([
    ['hook', { resolve: () => ({ hooks: { surprise: createSnapshotStore(1) } }) }],
    ['keyed hook', { resolve: () => ({ keyedHooks: { surprise: () => createSnapshotStore(1) } }) }],
    ['prop', { resolve: () => ({ props: { surprise: 1 } }) }],
  ] as const)('rejects an undeclared %s returned by a contribution', (kind, descriptor) => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    service.adapter.resolve(bench.binding(sessionId('s1')).sessionId)

    expect(() => { service.provide(descriptor as never) })
      .toThrow(`uiSession.provide: undeclared ${kind} 'surprise'`)
  })

  it.each([
    ['hook', { hooks: ['missing'], resolve: () => ({}) }],
    ['keyed hook', { keyedHooks: ['missing'], resolve: () => ({}) }],
    ['prop', { props: ['missing'], resolve: () => ({}) }],
  ] as const)('rejects a missing declared %s', (kind, descriptor) => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    service.adapter.resolve(bench.binding(sessionId('s1')).sessionId)

    expect(() => { service.provide(descriptor) })
      .toThrow(`uiSession.provide: missing ${kind} 'missing'`)
  })

  it.each([
    ['hook', { hooks: ['session'], resolve: () => ({ hooks: { session: createSnapshotStore(1) } }) }],
    ['keyed hook', {
      keyedHooks: ['projection'],
      resolve: () => ({ keyedHooks: { projection: () => createSnapshotStore(1) } }),
    }],
    ['prop', { props: ['sessionId'], resolve: () => ({ props: { sessionId: 'other' } }) }],
  ] as const)('rejects a duplicate declared %s', (kind, descriptor) => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)

    expect(() => { service.provide(descriptor) })
      .toThrow(`uiSession.provide: duplicate ${kind}`)
  })

  it('rejects cross-compartment collisions at the final standard prop name', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const source = createSnapshotStore(1)
    service.provide({
      hooks: ['feature'],
      resolve: () => ({ hooks: { feature: source } }),
    })
    const before = service.adapter.current.getSnapshot()

    expect(() => service.provide({
      keyedHooks: ['feature'],
      resolve: () => ({ keyedHooks: { feature: () => source } }),
    })).toThrow("uiSession.provide: duplicate keyed hook 'feature' at prop 'useFeature'")
    expect(() => service.provide({
      props: ['useFeature'],
      resolve: () => ({ props: { useFeature: true } }),
    })).toThrow("uiSession.provide: duplicate prop 'useFeature' at prop 'useFeature'")
    expect(service.adapter.current.getSnapshot()).toBe(before)
  })

  it('releases partially rebuilt bindings when a later Session contribution fails', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    service.adapter.resolve(bench.binding(sessionId('s1')).sessionId)
    service.adapter.resolve(bench.binding(sessionId('s2')).sessionId)
    let calls = 0

    expect(() => service.provide({
      props: ['partial'],
      resolve: () => {
        calls += 1
        if (calls === 2) throw new Error('second binding failed')
        return { props: { partial: true } }
      },
    })).toThrow('second binding failed')
    expect(calls).toBe(2)
    expect(service.adapter.resolve(sessionId('s1'))?.props).not.toHaveProperty('partial')
  })
})

/** One answerable presentation, exactly what a composer domain publishes. */
class TestPending {
  readonly result: Promise<string>
  readonly #settle: (outcome: string) => void
  readonly #reject: (reason: unknown) => void
  readonly #delegated = Symbol('delegated')

  constructor(readonly key: string, readonly kind: string, readonly sessionId: SessionId) {
    const completion = Promise.withResolvers<string>()
    this.result = completion.promise
    this.#settle = completion.resolve
    this.#reject = completion.reject
  }

  answer(outcome: string): void {
    this.#settle(outcome)
  }

  fail(reason: unknown): void {
    this.#reject(reason)
  }

  delegate(): void {
    this.#reject(this.#delegated)
  }

  isDelegation(reason: unknown): boolean {
    return reason === this.#delegated
  }
}

describe('UiSession pending interactions', () => {
  it('publishes the highest-precedence exact object and removes each settlement independently', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const id = sessionId('s1')
    const listener = vi.fn()
    const off = service.pendingInteractions.subscribe(listener)
    const settleApproval = service.registerPendingInteraction<TestPending>(() => 0)
    const settleQuestion = service.registerPendingInteraction<TestPending>(
      interaction => interaction.kind === 'plan-review' ? 2 : 1,
    )
    const settleBackground = service.registerPendingInteraction<TestPending>(() => -1)
    listener.mockClear()

    const approval = new TestPending('approval:1', 'approval', id)
    const duplicate = new TestPending('approval:2', 'approval', id)
    const question = new TestPending('question:1', 'question', id)
    const plan = new TestPending('question:2', 'plan-review', id)
    const background = new TestPending('background:1', 'background', id)
    const never = (): Promise<string> => Promise.reject(new Error('delegation not expected'))
    const settled = [
      settleApproval(approval, never),
      settleApproval(duplicate, never),
      settleQuestion(question, never),
      settleQuestion(plan, never),
      settleBackground(background, never),
    ]
    expect(service.pendingInteractions.getSnapshot().get(id)).toBe(plan)

    background.answer('background')
    await settled[4]
    question.answer('question')
    await settled[2]
    expect(service.pendingInteractions.getSnapshot().get(id)).toBe(plan)
    plan.answer('plan')
    await expect(settled[3]).resolves.toBe('plan')
    expect(service.pendingInteractions.getSnapshot().get(id)).toBe(duplicate)
    duplicate.answer('duplicate')
    await settled[1]
    expect(service.pendingInteractions.getSnapshot().get(id)).toBe(approval)
    approval.answer('approval')
    await settled[0]
    expect(service.pendingInteractions.getSnapshot().has(id)).toBe(false)
    off()
    await ctx.fiber.dispose()
  })

  it('resumes the Host waterfall on a delegation and propagates any other failure', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const id = sessionId('s1')
    const settle = service.registerPendingInteraction<TestPending>(() => 0)

    const delegated = new TestPending('question:1', 'question', id)
    const resumed = settle(delegated, () => Promise.resolve('waterfall'))
    delegated.delegate()
    await expect(resumed).resolves.toBe('waterfall')
    expect(service.pendingInteractions.getSnapshot().has(id)).toBe(false)

    const failure = new Error('composer failed')
    const failing = new TestPending('question:2', 'question', id)
    const propagated = settle(failing, () => Promise.resolve('waterfall'))
    failing.fail(failure)
    await expect(propagated).rejects.toBe(failure)
    expect(service.pendingInteractions.getSnapshot().has(id)).toBe(false)
    await ctx.fiber.dispose()
  })

  it('shows two domains one effective interaction per Session through one service', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const id = sessionId('s1')
    const settleApproval = service.registerPendingInteraction<TestPending>(() => 0)
    const settleQuestion = service.registerPendingInteraction<TestPending>(() => 1)
    const never = (): Promise<string> => Promise.reject(new Error('delegation not expected'))

    const approval = new TestPending('approval:1', 'approval', id)
    const question = new TestPending('question:1', 'question', id)
    const settled = [settleApproval(approval, never), settleQuestion(question, never)]

    // One owner: both domains project into a single snapshot entry, so the
    // composer takeover shows the higher-precedence question, not two rows.
    const shared = service.pendingInteractions.getSnapshot()
    expect(shared.size).toBe(1)
    expect(shared.get(id)).toBe(question)

    // A second owner is what a statically duplicated registry would produce.
    // Cordis already refuses a second `uiSession` on one Context, so the copy
    // needs its own root; each copy then sees only its own domain and the
    // single `sessionPendingInteraction` root hook strands the other.
    const duplicateCtx = new Context()
    const duplicateBench = createSessionsBench(duplicateCtx)
    const duplicate = createUiSession(duplicateCtx, duplicateBench)
    const settleDuplicate = duplicate.registerPendingInteraction<TestPending>(() => 1)
    const stranded = new TestPending('question:2', 'question', id)
    const strandedSettled = settleDuplicate(stranded, never)
    expect(service.pendingInteractions.getSnapshot().get(id)).toBe(question)
    expect(duplicate.pendingInteractions.getSnapshot().get(id)).toBe(stranded)

    approval.answer('approval')
    question.answer('question')
    stranded.answer('stranded')
    await Promise.all([...settled, strandedSettled])
    await duplicateCtx.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects duplicate keys and contains a failing aggregate subscriber', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const settle = service.registerPendingInteraction<TestPending>(() => 1)
    const interaction = new TestPending('question:1', 'question', sessionId('s1'))
    const never = (): Promise<string> => Promise.reject(new Error('delegation not expected'))
    const settled = settle(interaction, never)
    await expect(settle(interaction, never))
      .rejects.toThrow("ui-session: duplicate pending interaction key 'question:1'")

    const failure = new Error('pending subscriber failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    service.pendingInteractions.subscribe(() => { throw failure })
    const after = vi.fn()
    service.pendingInteractions.subscribe(after)

    interaction.answer('question')
    await settled

    expect(after).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(
      '[ui-session] pending interactions subscriber failed:',
      failure,
    )
    await ctx.fiber.dispose()
  })

  it('removes active values before awaiting their teardown delegation', async () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const service = createUiSession(ctx, bench)
    const gate = Promise.withResolvers<string>()
    const settle = service.registerPendingInteraction<TestPending>(() => 1)
    const pending = new TestPending('question:1', 'question', sessionId('s1'))
    const settled = settle(pending, () => gate.promise)

    let disposed = false
    const disposal = ctx.fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => {
      expect(service.pendingInteractions.getSnapshot()).toEqual(new Map())
    })
    expect(disposed).toBe(false)

    gate.resolve('waterfall')
    await expect(settled).resolves.toBe('waterfall')
    await disposal
    expect(disposed).toBe(true)
  })
})

describe('ui-session apply', () => {
  it('provides the root sources and installs the Session scope adapter', () => {
    const ctx = new Context()
    const bench = createSessionsBench(ctx)
    const slots = {
      provideRoot: vi.fn(),
      installScope: vi.fn(),
    }
    ctx.provide('sessions', bench.sessions)
    ctx.provide('slots', slots as never)

    apply(ctx)

    expect(ctx.uiSession).toBeInstanceOf(UiSession)
    expect(slots.provideRoot).toHaveBeenCalledWith({
      hooks: {
        sessions: bench.sessions.list,
        sessionPendingInteraction: ctx.uiSession.pendingInteractions,
      },
    })
    expect(slots.installScope).toHaveBeenCalledWith('session', ctx.uiSession.adapter)
  })

  it('keeps the Host loader half inert and registers the invariant companion', async () => {
    expect(() => { nodeApply() }).not.toThrow()
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(SessionInvariant).await()).resolves.toBeDefined()
  })
})
