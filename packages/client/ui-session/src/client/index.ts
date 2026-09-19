/** Session Controller bindings for React selector hooks and Slot scope data. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ISessions,
  SessionBinding,
  SessionListState,
  SessionSnapshot,
  UseProjection,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { standardHookPropName } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  HostObservable,
  KeyedStandardSource,
  MaybeSnapshotSelectorHook,
  RootStandardSourceContribution,
  ScopedStandardSourceBinding,
  SlotScopeAdapter,
  SnapshotSelectorHook,
  StandardSourceBinding,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { renderSessionArea } from './session-provider.tsx'

/** Selector hook over the Session Controller list and current selection. */
export type UseSessions = SnapshotSelectorHook<SessionListState>
/** Selector hook over one Session's lifecycle and control state. */
export type SessionSnapshotSelector = SnapshotSelectorHook<SessionSnapshot>
/** Public name for the Session lifecycle selector hook. */
export type UseSession = SessionSnapshotSelector

/** Common identity carried by every Session-scoped pending interaction. */
export interface SessionPendingInteractionBase {
  /** Opaque request identity; a replacement request must use a new key. */
  readonly key: string
  /** Domain-owned presentation discriminator. */
  readonly kind: string
  /** Session whose UI can answer this interaction. */
  readonly sessionId: SessionId
}

/** Declaration-merged roster of domain-owned pending interaction values. */
export interface SessionPendingInteractionMap {}

/** Every pending interaction contributed by the assembled Client. */
export type SessionPendingInteraction =
  [keyof SessionPendingInteractionMap] extends [never]
    ? SessionPendingInteractionBase
    : SessionPendingInteractionMap[keyof SessionPendingInteractionMap]

/** Current effective pending interaction by Session. */
export type SessionPendingInteractionSnapshot = ReadonlyMap<SessionId, SessionPendingInteraction>
/** Selector hook over Session-scoped pending interactions. */
export type UseSessionPendingInteraction = SnapshotSelectorHook<SessionPendingInteractionSnapshot>

/** A pending presentation that can hand its request back to the Host waterfall. */
export interface DelegatablePendingInteraction<Outcome> {
  /** Result returned to the waiting Host listener. */
  readonly result: Promise<Outcome>
  /** Reject {@link DelegatablePendingInteraction.result} with the delegation marker. */
  delegate: () => void
  /**
   * Test whether a rejection requests waterfall delegation.
   * @param reason - rejection received from `result`.
   * @returns whether `delegate` produced it.
   */
  isDelegation: (reason: Thrown) => boolean
}

/**
 * Publish one pending interaction of a registered domain and settle it: the
 * user's answer wins, a delegation resumes the Host waterfall, and any other
 * rejection propagates.
 */
export type PendingInteractionSettler<T extends SessionPendingInteractionBase> = <Outcome>(
  interaction: T & DelegatablePendingInteraction<Outcome>,
  delegated: () => Promise<Outcome>,
) => Promise<Outcome>

interface PendingInteractionEntry<T> {
  readonly interaction: T
  readonly delegate: () => Promise<void>
}

type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

class PendingInteractionDomain {
  private readonly values = new Map<string, PendingInteractionEntry<SessionPendingInteractionBase>>()

  constructor(
    readonly precedence: (interaction: SessionPendingInteractionBase) => number,
    private readonly changed: () => void,
  ) {}

  valuesSnapshot(): readonly SessionPendingInteractionBase[] {
    return [...this.values.values()].map(entry => entry.interaction)
  }

  publish(interaction: SessionPendingInteractionBase, delegate: () => Promise<void>): () => void {
    if (this.values.has(interaction.key)) {
      throw new Error(`ui-session: duplicate pending interaction key '${interaction.key}'`)
    }
    this.values.set(interaction.key, { interaction, delegate })
    this.changed()
    return () => {
      if (!this.values.delete(interaction.key)) return
      this.changed()
    }
  }

  /** Remove every pending value and return the operations that settle their owners. */
  release(): readonly (() => Promise<void>)[] {
    const delegates = [...this.values.values()].map(entry => entry.delegate)
    this.values.clear()
    return delegates
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Session list and current selection. */
    useSessions: UseSessions
    /** Pending user interaction presented by a Session-scoped UI consumer. */
    useSessionPendingInteraction: UseSessionPendingInteraction
  }

  interface SessionStandardProps {
    /** Current Session lifecycle and control state. */
    useSession: SessionSnapshotSelector
    /** Current Session identity. */
    sessionId: SessionId
    /** Host-computed projection values addressed by projection key. */
    useProjection: UseProjection
  }

  interface SessionMaybeStandardProps {
    /** Current Session state, absent while no Session is selected. */
    useSession: MaybeSnapshotSelectorHook<SessionSnapshot>
    /** Current Session identity, absent while no Session is selected. */
    sessionId: SessionId | undefined
    /** Host-computed projection values; every key is absent without a Session. */
    useProjection: UseProjection
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session Controller bindings and session-scoped source registry. */
    uiSession: UiSession
  }
}

type SessionSourceRoster = readonly string[] | undefined
type StandardMemberKind = 'hook' | 'keyed hook' | 'prop'

type SessionSourceRecord<Roster extends SessionSourceRoster, Value> =
  Roster extends readonly string[] ? Readonly<Record<Roster[number], Value>> : never

/** Bare values produced by one Session-scoped source contribution. */
export interface SessionSourceContribution<
  Hooks extends SessionSourceRoster = SessionSourceRoster,
  KeyedHooks extends SessionSourceRoster = SessionSourceRoster,
  Props extends SessionSourceRoster = SessionSourceRoster,
> {
  readonly hooks?: SessionSourceRecord<Hooks, HostObservable<unknown>>
  readonly keyedHooks?: SessionSourceRecord<KeyedHooks, KeyedStandardSource>
  readonly props?: SessionSourceRecord<Props, unknown>
}

/** Static roster and per-Session resolver for one standard-props contribution. */
export interface SessionSourceDescriptor<
  Hooks extends SessionSourceRoster = SessionSourceRoster,
  KeyedHooks extends SessionSourceRoster = SessionSourceRoster,
  Props extends SessionSourceRoster = SessionSourceRoster,
> {
  readonly hooks?: Hooks
  readonly keyedHooks?: KeyedHooks
  readonly props?: Props
  /**
   * Resolve every declared member for one Session binding.
   * @param binding - Controller-owned Session binding.
   * @returns all declared bare sources and stable props.
   */
  resolve(binding: SessionBinding): SessionSourceContribution<
    NoInfer<Hooks>,
    NoInfer<KeyedHooks>,
    NoInfer<Props>
  >
}

interface RuntimeSessionSourceContribution {
  readonly hooks?: Readonly<Record<string, HostObservable<unknown>>>
  readonly keyedHooks?: Readonly<Record<string, KeyedStandardSource>>
  readonly props?: Readonly<Record<string, unknown>>
}

interface RuntimeSessionSourceDescriptor {
  readonly hooks?: readonly string[]
  readonly keyedHooks?: readonly string[]
  readonly props?: readonly string[]
  resolve(binding: SessionBinding): RuntimeSessionSourceContribution
}

interface MaterializedBinding {
  readonly owner: SessionBinding
  readonly value: ScopedStandardSourceBinding
  readonly release: () => void | Promise<void>
}

const BUILTIN_SOURCE = {
  hooks: ['session'],
  keyedHooks: ['projection'],
  props: ['sessionId'],
  resolve: binding => ({
    hooks: { session: binding.session },
    keyedHooks: { projection: key => binding.session.projections.faceOf(key) },
    props: { sessionId: binding.sessionId },
  }),
} satisfies SessionSourceDescriptor<
  readonly ['session'],
  readonly ['projection'],
  readonly ['sessionId']
>

/** Session-scoped source roster and renderer SlotScopeAdapter. */
export class UiSession extends Service {
  private readonly descriptors: RuntimeSessionSourceDescriptor[] = [
    BUILTIN_SOURCE,
  ]
  private bindings = new Map<SessionId, MaterializedBinding>()
  private absent: StandardSourceBinding
  private currentBinding: StandardSourceBinding
  private readonly currentListeners = new Set<() => void>()
  private readonly pendingDomains: PendingInteractionDomain[] = []
  private pendingSnapshot: ReadonlyMap<SessionId, SessionPendingInteractionBase> = new Map()
  private readonly pendingListeners = new Set<() => void>()
  /** Root source of pending UI interactions, independent from Controller snapshots. */
  readonly pendingInteractions: HostObservable<SessionPendingInteractionSnapshot> = {
    getSnapshot: () => this.pendingSnapshot,
    subscribe: (listener) => {
      this.pendingListeners.add(listener)
      return () => { this.pendingListeners.delete(listener) }
    },
  }
  /** Renderer-facing SlotScopeAdapter for `session` and `session-maybe` scopes. */
  readonly adapter: SlotScopeAdapter

  /**
   * @param ctx - Client root context.
   * @param sessions - Controller-owned Session object layer.
   */
  constructor(
    ctx: Context,
    private readonly sessions: ISessions,
  ) {
    super(ctx, 'uiSession')
    this.absent = this.materializeAbsent()
    this.currentBinding = this.resolveCurrent()
    this.adapter = {
      current: {
        getSnapshot: () => this.currentBinding,
        subscribe: (listener) => {
          this.currentListeners.add(listener)
          return () => { this.currentListeners.delete(listener) }
        },
      },
      resolve: key => this.resolve(SessionId(key)),
      renderArea: renderSessionArea,
    }

    ctx.effect(() => {
      const disposeList = sessions.list.subscribe(() => { this.publishCurrent() })
      return () => {
        disposeList()
        const records = [...this.bindings.values()]
        this.bindings.clear()
        for (const record of records) record.release()
      }
    }, 'ui-session: Session binding projection')
  }

  /**
   * Register one Session-scoped standard-source contribution.
   * @param descriptor - static member roster and per-binding resolver.
   * @returns disposer owned by the caller's Cordis fiber.
   */
  provide<
    const Hooks extends SessionSourceRoster = undefined,
    const KeyedHooks extends SessionSourceRoster = undefined,
    const Props extends SessionSourceRoster = undefined,
  >(descriptor: SessionSourceDescriptor<Hooks, KeyedHooks, Props>): () => void {
    const runtimeDescriptor = runtimeDescriptorOf(descriptor)
    return this.ctx.effect(() => {
      this.descriptors.push(runtimeDescriptor)
      let committed = false
      using _rollbackProvide = {
        [Symbol.dispose]: (): void => {
          if (!committed) this.descriptors.pop()
        },
      }
      this.rebuildBindings()
      committed = true
      return () => {
        const index = this.descriptors.indexOf(runtimeDescriptor)
        this.descriptors.splice(index, 1)
        this.rebuildBindings()
      }
    }, 'uiSession.provide()')
  }

  /**
   * Register one pending-interaction domain and return its settler. Publication
   * and settlement are one operation with one settlement point: the settler
   * publishes the interaction, awaits the user's answer, resumes the Host
   * waterfall on a delegation, and removes the publication in every outcome.
   * Domain teardown first removes its visible values, then delegates and awaits
   * every still-active owner request, so the domain is quiescent before its
   * owner's fiber disposes.
   * @param precedence - deterministic cross-domain precedence; larger values win.
   * @returns the domain's settler for one interaction at a time.
   */
  registerPendingInteraction<T extends SessionPendingInteractionBase>(
    precedence: (interaction: SessionPendingInteractionBase) => number,
  ): PendingInteractionSettler<T> {
    const domain = new PendingInteractionDomain(precedence, () => {
      this.publishPendingInteractions()
    })
    this.ctx.effect(() => {
      this.pendingDomains.push(domain)
      this.publishPendingInteractions()
      return async () => {
        const delegates = domain.release()
        const index = this.pendingDomains.indexOf(domain)
        this.pendingDomains.splice(index, 1)
        this.publishPendingInteractions()
        await Promise.allSettled(delegates.map(delegate => Promise.resolve().then(delegate)))
      }
    }, 'uiSession.registerPendingInteraction()')
    return async (interaction, delegated) => {
      const completed = Promise.withResolvers<void>()
      const remove = domain.publish(interaction, async () => {
        interaction.delegate()
        await completed.promise
      })
      using _settle = {
        [Symbol.dispose]: (): void => {
          remove()
          completed.resolve()
        },
      }
      const outcome = await interaction.result.then(
        value => ({ kind: 'answered' as const, value }),
        (reason: Thrown) => (
          interaction.isDelegation(reason)
            ? { kind: 'delegated' as const }
            : { kind: 'failed' as const, reason }
        ),
      )
      if (outcome.kind === 'answered') return outcome.value
      if (outcome.kind === 'delegated') return await delegated()
      throw outcome.reason
    }
  }

  private rebuildBindings(): void {
    const absent = this.materializeAbsent()
    const bindings = new Map<SessionId, MaterializedBinding>()
    const created: MaterializedBinding[] = []
    let committed = false
    using _rollbackBindings = {
      [Symbol.dispose]: (): void => {
        if (committed) return
        for (const record of created) record.release()
      },
    }
    for (const [sessionId, cached] of this.bindings) {
      const record = this.createMaterializedBinding(cached.owner)
      created.push(record)
      bindings.set(sessionId, record)
    }
    const previous = this.bindings
    this.absent = absent
    this.bindings = bindings
    committed = true
    for (const record of previous.values()) record.release()
    this.publishCurrent()
  }

  private resolve(key: SessionId): ScopedStandardSourceBinding | undefined {
    const owner = this.sessions.binding(key)
    if (owner === undefined) return undefined
    const cached = this.bindings.get(key)
    if (cached?.owner === owner) return cached.value
    const record = this.createMaterializedBinding(owner)
    this.bindings.set(key, record)
    cached?.release()
    return record.value
  }

  private resolveCurrent(): StandardSourceBinding {
    const current = this.sessions.list.getSnapshot().current
    return current === undefined ? this.absent : this.resolve(current) ?? this.absent
  }

  private publishCurrent(): void {
    const next = this.resolveCurrent()
    if (next === this.currentBinding) return
    this.currentBinding = next
    notifySubscribers(this.currentListeners, '[ui-session] current binding')
  }

  private publishPendingInteractions(): void {
    const next = new Map<SessionId, {
      interaction: SessionPendingInteractionBase
      precedence: number
    }>()
    for (const domain of this.pendingDomains) {
      for (const interaction of domain.valuesSnapshot()) {
        const precedence = domain.precedence(interaction)
        const previous = next.get(interaction.sessionId)
        if (previous === undefined || precedence >= previous.precedence) {
          next.set(interaction.sessionId, { interaction, precedence })
        }
      }
    }
    const projected = new Map(
      [...next].map(([sessionId, value]) => [sessionId, value.interaction] as const),
    )
    if (samePendingInteractions(this.pendingSnapshot, projected)) return
    this.pendingSnapshot = projected
    notifySubscribers(this.pendingListeners, '[ui-session] pending interactions')
  }

  private createMaterializedBinding(owner: SessionBinding): MaterializedBinding {
    const value = this.materialize(owner)
    const releaseEffect = owner.ctx.effect(() => () => {
      if (this.bindings.get(owner.sessionId) !== record) return
      this.bindings.delete(owner.sessionId)
      if (this.currentBinding !== value) return
      this.currentBinding = this.absent
      notifySubscribers(this.currentListeners, '[ui-session] current binding')
    }, `ui-session: binding ${owner.sessionId}`)
    const record: MaterializedBinding = {
      owner,
      value,
      release: () => Promise.resolve(releaseEffect()),
    }
    return record
  }

  private materialize(binding: SessionBinding): ScopedStandardSourceBinding {
    const hooks: Record<string, HostObservable<unknown>> = {}
    const keyedHooks: Record<string, KeyedStandardSource> = {}
    const props: Record<string, unknown> = {}
    const finalProps = new Set<string>()
    for (const descriptor of this.descriptors) {
      const contribution = descriptor.resolve(binding)
      validateContribution(descriptor, contribution)
      copyDeclared('hook', hooks, descriptor.hooks, contribution.hooks, finalProps)
      copyDeclared('keyed hook', keyedHooks, descriptor.keyedHooks, contribution.keyedHooks, finalProps)
      copyDeclared('prop', props, descriptor.props, contribution.props, finalProps)
    }
    const value: ScopedStandardSourceBinding = {
      key: binding.sessionId,
      ctx: binding.ctx,
      hooks,
      keyedHooks,
      props,
    }
    this.ctx.slots.bindStoreScope(value)
    return value
  }

  private materializeAbsent(): StandardSourceBinding {
    const hooks: Record<string, undefined> = {}
    const keyedHooks: Record<string, undefined> = {}
    const props: Record<string, undefined> = {}
    const finalProps = new Set<string>()
    for (const descriptor of this.descriptors) {
      declareAbsent('hook', hooks, descriptor.hooks, finalProps)
      declareAbsent('keyed hook', keyedHooks, descriptor.keyedHooks, finalProps)
      declareAbsent('prop', props, descriptor.props, finalProps)
    }
    return { key: undefined, hooks, keyedHooks, props }
  }
}

function runtimeDescriptorOf(
  descriptor: SessionSourceDescriptor,
): RuntimeSessionSourceDescriptor {
  return {
    ...(descriptor.hooks === undefined ? {} : { hooks: descriptor.hooks }),
    ...(descriptor.keyedHooks === undefined ? {} : { keyedHooks: descriptor.keyedHooks }),
    ...(descriptor.props === undefined ? {} : { props: descriptor.props }),
    resolve: (binding) => {
      const contribution = descriptor.resolve(binding)
      return {
        ...(contribution.hooks === undefined ? {} : { hooks: contribution.hooks }),
        ...(contribution.keyedHooks === undefined ? {} : { keyedHooks: contribution.keyedHooks }),
        ...(contribution.props === undefined ? {} : { props: contribution.props }),
      }
    },
  }
}

function validateContribution(
  descriptor: RuntimeSessionSourceDescriptor,
  contribution: RuntimeSessionSourceContribution,
): void {
  rejectUndeclared('hook', descriptor.hooks, contribution.hooks)
  rejectUndeclared('keyed hook', descriptor.keyedHooks, contribution.keyedHooks)
  rejectUndeclared('prop', descriptor.props, contribution.props)
}

function rejectUndeclared(
  kind: string,
  declared: readonly string[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): void {
  for (const name of Object.keys(values ?? {})) {
    if (!(declared ?? []).includes(name)) {
      throw new Error(`uiSession.provide: undeclared ${kind} '${name}'`)
    }
  }
}

function copyDeclared<T>(
  kind: StandardMemberKind,
  target: Record<string, T>,
  declared: readonly string[] | undefined,
  values: Readonly<Record<string, T>> | undefined,
  finalProps: Set<string>,
): void {
  for (const name of declared ?? []) {
    claimStandardProp(kind, name, finalProps)
    const value = values?.[name]
    if (value === undefined) throw new Error(`uiSession.provide: missing ${kind} '${name}'`)
    target[name] = value
  }
}

function declareAbsent(
  kind: StandardMemberKind,
  target: Record<string, undefined>,
  declared: readonly string[] | undefined,
  finalProps: Set<string>,
): void {
  for (const name of declared ?? []) {
    claimStandardProp(kind, name, finalProps)
    target[name] = undefined
  }
}

function claimStandardProp(kind: StandardMemberKind, name: string, finalProps: Set<string>): void {
  const propName = kind === 'prop' ? name : standardHookPropName(name)
  if (finalProps.has(propName)) {
    throw new Error(`uiSession.provide: duplicate ${kind} '${name}' at prop '${propName}'`)
  }
  finalProps.add(propName)
}

/** Required Controller and renderer services. */
export const inject = ['sessions', 'slots']

/**
 * Install the Session root source and scoped SlotScopeAdapter.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  const service = new UiSession(ctx, ctx.sessions)
  ctx.slots.provideRoot({
    hooks: {
      sessions: ctx.sessions.list,
      sessionPendingInteraction: service.pendingInteractions,
    },
  } satisfies RootStandardSourceContribution)
  ctx.slots.installScope('session', service.adapter)
}

function samePendingInteractions(
  left: ReadonlyMap<SessionId, SessionPendingInteractionBase>,
  right: ReadonlyMap<SessionId, SessionPendingInteractionBase>,
): boolean {
  if (left.size !== right.size) return false
  for (const [sessionId, interaction] of left) {
    if (right.get(sessionId) !== interaction) return false
  }
  return true
}
