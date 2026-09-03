/** Per-DevTools-session Runtime routing across uniform Host and Client realms. */

import type { InspectorSourceDescriptor } from '../../../../shared/bridge/messages/observation.ts'
import type { InspectorRealmId, RuntimeBackendObjectHandle } from '../../../../shared/cdp/ids.ts'
import type { RuntimeCallArgument, RuntimeCompletion } from '../../../../shared/cdp/operations.ts'
import type { RuntimeRemoteObject } from '../../../../shared/cdp/remote-object.ts'
import type { RuntimeExecutionContext } from '../../../../shared/cdp/operations.ts'
import type { RuntimeBackend } from '../../../../shared/cdp/realm.ts'
import { cdpError, respondToCdpRequest, type CdpRequest, type CdpTransport } from '../../protocol.ts'
import type { InspectorRealmSession } from '../../../inspection/realm.ts'
import type { InspectorRealmSessionEvent, InspectorRealmSessionSet } from '../../realm-sessions.ts'
import {
  parseAwaitPromise,
  parseCallFunction,
  parseEvaluate,
  parseGetProperties,
  parseGlobalLexicalScopeNames,
  parseReleaseObject,
  parseReleaseObjectGroup,
  type CdpCallArgument,
  type CdpExecutionContextSelector,
} from './cdp-params.ts'
import { RuntimeObjectTable, type RuntimeObjectObserver } from './object-table.ts'
import type { RuntimeObjectRoute } from './object-table.ts'

/** Runtime router layered over the common per-connection realm sessions. */
export class RuntimeDomainSession {
  private readonly objects: RuntimeObjectTable
  private readonly announcedContexts = new Set<number>()
  private readonly consoleSubscriptions = new Map<InspectorRealmId, Promise<() => void>>()
  private readonly unsubscribeRealms: () => void
  private readonly settledListeners = new Set<() => void>()
  private pendingAnnouncements = 0
  private enabled = false
  private closed = false

  constructor(
    private readonly transport: CdpTransport,
    private readonly realms: InspectorRealmSessionSet,
  ) {
    this.objects = new RuntimeObjectTable(realms.connectionId)
    this.unsubscribeRealms = realms.subscribe((event) => { this.receiveRealm(event) })
  }

  /**
   * Handle methods that require cross-realm Runtime coordination.
   * @param request - Parsed CDP request.
   * @returns Whether this domain owns the method or object id.
   */
  handle(request: CdpRequest): boolean {
    switch (request.method) {
      case 'Runtime.enable':
        this.respond(request, () => this.enable())
        return true
      case 'Runtime.disable':
        this.respond(request, () => this.disable())
        return true
      case 'Runtime.evaluate':
        this.respond(request, () => this.evaluate(request.params))
        return true
      case 'Runtime.getProperties':
        return this.getProperties(request)
      case 'Runtime.callFunctionOn':
        return this.callFunction(request)
      case 'Runtime.awaitPromise':
        return this.awaitPromise(request)
      case 'Runtime.releaseObject':
        return this.releaseObject(request)
      case 'Runtime.releaseObjectGroup':
        this.respond(request, () => this.releaseObjectGroup(request.params))
        return true
      case 'Runtime.globalLexicalScopeNames':
        this.respond(request, () => this.globalLexicalScopeNames(request.params))
        return true
      case 'Runtime.discardConsoleEntries':
        this.respond(request, () => this.discardConsoleEntries())
        return true
      default:
        if (request.method.startsWith('Runtime.')) {
          const reason = this.unsupportedNativeRoute(request.params)
          if (reason !== undefined) {
            this.sendError(request, reason)
            return true
          }
        }
        return false
    }
  }

  /** Release this connection's object routes and realm subscription. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeRealms()
    this.detachConsoles()
    this.objects.clear()
    this.announcedContexts.clear()
    this.settledListeners.clear()
  }

  /**
   * Report whether this connection still owes an execution-context announcement.
   *
   * A realm is admitted while its Console subscription is still being established, and that
   * establishment reply and the realm's first observation records can reach the Worker in one
   * socket read. Domains that expose realm-owned entities read this before writing, so this
   * connection never learns of a node before the context that owns it.
   * @returns True from realm admission until the announcement is sent or the realm is dropped.
   */
  announcementPending(): boolean {
    return this.pendingAnnouncements > 0
  }

  /**
   * Observe every completed execution-context announcement.
   * @param listener - Called after one announcement is sent or dropped; reads
   * {@link announcementPending} for the state the announcement left behind.
   * @returns A disposer removing the listener.
   */
  onAnnouncementSettled(listener: () => void): () => void {
    this.settledListeners.add(listener)
    return () => { this.settledListeners.delete(listener) }
  }

  /**
   * Install semantic object recognition shared with the DOM adapter.
   * @param observer - Callback invoked for objects carrying semantic references.
   */
  setObjectObserver(observer: RuntimeObjectObserver): void {
    this.objects.setObserver(observer)
  }

  /**
   * Resolve a connection-local CDP object id for another domain adapter.
   * @param objectId - CDP object id allocated by this Runtime session.
   * @returns Its realm and backend handle when still live.
   */
  objectRoute(objectId: string): RuntimeObjectRoute | undefined {
    return this.objects.resolve(objectId)
  }

  /**
   * Project a completion produced by another domain through this connection's object table.
   * @param realm - Realm session that owns the completion.
   * @param completion - Realm-neutral result and exception fields.
   * @param group - Object group assigned to exposed handles.
   * @returns CDP Runtime result fields.
   */
  projectCompletion(
    realm: InspectorRealmSession,
    completion: RuntimeCompletion<RuntimeBackendObjectHandle>,
    group: string | undefined,
  ): object {
    return this.objects.completion(realm, completion, group)
  }

  /**
   * Project one Runtime value produced by another domain.
   * @param realm - Realm session that owns the value.
   * @param value - Realm-neutral Runtime value.
   * @param group - Object group assigned to an exposed handle.
   * @returns CDP RemoteObject fields.
   */
  projectRemoteObject(
    realm: InspectorRealmSession,
    value: RuntimeRemoteObject<RuntimeBackendObjectHandle>,
    group: string | undefined,
  ): Readonly<Record<string, unknown>> {
    return this.objects.remote(realm, value, group)
  }

  /**
   * Forget connection-local ids retained for another domain's object group.
   * @param group - Object group whose projected ids have expired.
   */
  releaseProjectedGroup(group: string): void {
    this.objects.releaseGroup(group)
  }

  /**
   * Replace common object ids with native backend handles in a Host-only request.
   * @param params - Parsed CDP parameters that may contain nested object ids.
   * @returns A detached parameter record suitable for the native Host protocol.
   */
  nativeParameters(params: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    const visit = (value: unknown, key: string | undefined): unknown => {
      if ((key === 'objectId' || key?.endsWith('ObjectId') === true) && typeof value === 'string') {
        const route = this.objects.resolve(value)
        if (route === undefined) return value
        if (route.realm.nativeDomains.state === 'unsupported') throw new Error(route.realm.nativeDomains.reason)
        return route.handle
      }
      if (Array.isArray(value)) return value.map(item => visit(item, undefined))
      if (typeof value !== 'object' || value === null) return value
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, visit(item, name)]))
    }
    return visit(params, undefined) as Readonly<Record<string, unknown>>
  }

  /**
   * Resolve one realm-registry expression to a connection-local object id.
   * @param source - Source generation that owns the Cordis tree node.
   * @param expression - Side-effect-free realm object lookup.
   * @param objectGroup - Optional DevTools retention group.
   * @returns The CDP RemoteObject fields.
   */
  async resolveObject(
    source: InspectorSourceDescriptor,
    expression: string,
    objectGroup: string | undefined,
  ): Promise<Readonly<Record<string, unknown>>> {
    const realm = this.realms.bySource(source)
    if (realm === undefined) throw new Error('Cordis realm is no longer connected')
    const runtime = runtimeBackend(realm)
    const completion = await runtime.evaluate({
      expression,
      generatePreview: true,
      ...(objectGroup === undefined ? {} : { objectGroup }),
    })
    if (completion.exceptionDetails !== undefined) throw new Error('Cordis object lookup failed')
    return this.objects.completion(realm, completion, objectGroup).result
  }

  private async enable(): Promise<object> {
    this.enabled = true
    this.pendingAnnouncements++
    try {
      const admitted = await Promise.all(this.realms.all().map(realm => this.admitRealm(realm)))
      // Announced in registry order, not completion order, so two connections
      // that admit the same realms describe them in the same sequence.
      for (const realm of admitted) if (realm !== undefined) this.announce(realm)
      return {}
    } finally {
      this.settleAnnouncement()
    }
  }

  private async disable(): Promise<object> {
    this.detachConsoles()
    try {
      await Promise.all(this.realms.all().map(async (realm) => { await runtimeBackend(realm).disable() }))
    } finally {
      this.enabled = false
      this.objects.clear()
      this.announcedContexts.clear()
    }
    return {}
  }

  private async evaluate(params: Readonly<Record<string, unknown>>): Promise<object> {
    const parsed = parseEvaluate(params)
    const realm = this.realmFromSelector(parsed, 'contextId')
    const completion = await runtimeBackend(realm).evaluate({
      ...parsed.request,
      ...this.backendContext(realm, parsed, 'contextId'),
    })
    return this.objects.completion(realm, completion, parsed.request.objectGroup)
  }

  private getProperties(request: CdpRequest): boolean {
    const objectId = request.params.objectId
    if (typeof objectId !== 'string') return false
    const route = this.objects.resolve(objectId)
    if (route === undefined) return false
    this.respond(request, async () => {
      const parsed = parseGetProperties(request.params)
      const properties = await runtimeBackend(route.realm).getProperties({ ...parsed.request, handle: route.handle })
      return this.objects.properties(route.realm, properties, route.group)
    })
    return true
  }

  private callFunction(request: CdpRequest): boolean {
    const objectId = typeof request.params.objectId === 'string' ? request.params.objectId : undefined
    const receiver = objectId === undefined ? undefined : this.objects.resolve(objectId)
    const selected = this.realmFromOptionalSelector(request.params, 'executionContextId')
    if (receiver === undefined && selected === undefined && objectId !== undefined) return false
    const realm = receiver?.realm ?? selected ?? this.realms.host()
    if (receiver !== undefined && selected !== undefined && receiver.realm !== selected) {
      this.sendError(request, 'Runtime.callFunctionOn receiver and execution context belong to different realms')
      return true
    }
    this.respond(request, async () => {
      const parsed = parseCallFunction(request.params)
      const group = parsed.request.objectGroup ?? receiver?.group
      const completion = await runtimeBackend(realm).callFunction({
        ...parsed.request,
        ...this.backendContext(realm, parsed, 'executionContextId'),
        ...(receiver === undefined ? {} : { receiver: receiver.handle }),
        arguments: parsed.arguments.map(argument => this.routeArgument(realm, argument)),
      })
      return this.objects.completion(realm, completion, group)
    })
    return true
  }

  private awaitPromise(request: CdpRequest): boolean {
    const objectId = request.params.promiseObjectId
    if (typeof objectId !== 'string') return false
    const route = this.objects.resolve(objectId)
    if (route === undefined) return false
    this.respond(request, async () => {
      const parsed = parseAwaitPromise(request.params)
      const completion = await runtimeBackend(route.realm).awaitPromise({ ...parsed.request, promise: route.handle })
      return this.objects.completion(route.realm, completion, route.group)
    })
    return true
  }

  private releaseObject(request: CdpRequest): boolean {
    const objectId = request.params.objectId
    if (typeof objectId !== 'string') return false
    const route = this.objects.resolve(objectId)
    if (route === undefined) return false
    this.respond(request, async () => {
      parseReleaseObject(request.params)
      await runtimeBackend(route.realm).releaseObject(route.handle)
      this.objects.release(objectId)
      return {}
    })
    return true
  }

  private async releaseObjectGroup(params: Readonly<Record<string, unknown>>): Promise<object> {
    const group = parseReleaseObjectGroup(params)
    const realms = this.objects.realmsInGroup(group)
    try {
      await Promise.all(realms.map(async (realm) => { await runtimeBackend(realm).releaseObjectGroup(group) }))
    } finally {
      this.objects.releaseGroup(group)
    }
    return {}
  }

  private async globalLexicalScopeNames(params: Readonly<Record<string, unknown>>): Promise<object> {
    const parsed = parseGlobalLexicalScopeNames(params)
    const realm = this.realmFromSelector(parsed, 'executionContextId')
    const context = this.backendContext(realm, parsed, 'executionContextId').context
    return { names: await runtimeBackend(realm).globalLexicalScopeNames(context) }
  }

  private async discardConsoleEntries(): Promise<object> {
    await Promise.all(this.realms.all().map(async (realm) => {
      if (realm.console.state === 'supported') await realm.console.backend.clear()
      await runtimeBackend(realm).releaseObjectGroup('console')
    }))
    this.objects.releaseGroup('console')
    return {}
  }

  private realmFromSelector(
    params: CdpExecutionContextSelector,
    numericKey: 'contextId' | 'executionContextId',
  ): InspectorRealmSession {
    return this.realmFromOptionalSelector(params, numericKey) ?? this.realms.host()
  }

  private realmFromOptionalSelector(
    params: CdpExecutionContextSelector,
    numericKey: 'contextId' | 'executionContextId',
  ): InspectorRealmSession | undefined {
    const numeric = params[numericKey]
    if (typeof numeric === 'number' && Number.isSafeInteger(numeric)) {
      const realm = this.realms.byContextId(numeric)
      if (realm !== undefined) return realm
      if (numeric < 0) throw new Error('Client execution context is no longer available')
      return this.realms.host()
    }
    const unique = params.uniqueContextId
    if (typeof unique === 'string') {
      const realm = this.realms.byUniqueContextId(unique)
      if (realm !== undefined) return realm
      if (unique.startsWith('dsh-client:')) throw new Error('Client execution context is no longer available')
      return this.realms.host()
    }
    return undefined
  }

  private backendContext(
    realm: InspectorRealmSession,
    params: CdpExecutionContextSelector,
    numericKey: 'contextId' | 'executionContextId',
  ): { readonly context?: RuntimeExecutionContext } {
    if (realm.context.kind !== 'native') return {}
    const numeric = params[numericKey]
    if (typeof numeric === 'number') return { context: { kind: 'numeric', id: numeric } }
    return params.uniqueContextId === undefined
      ? {}
      : { context: { kind: 'unique', id: params.uniqueContextId } }
  }

  private routeArgument(
    realm: InspectorRealmSession,
    argument: CdpCallArgument,
  ): RuntimeCallArgument<RuntimeBackendObjectHandle> {
    if (argument.kind !== 'object') return argument
    const route = this.objects.resolve(argument.objectId)
    if (route === undefined || route.realm !== realm) {
      throw new Error('Runtime.callFunctionOn cannot pass an object between realms')
    }
    return { kind: 'object', handle: route.handle }
  }

  private unsupportedNativeRoute(params: Readonly<Record<string, unknown>>): string | undefined {
    for (const key of ['contextId', 'executionContextId'] as const) {
      const contextId = params[key]
      if (typeof contextId !== 'number') continue
      const realm = this.realms.byContextId(contextId)
      if (realm?.nativeDomains.state === 'unsupported') return realm.nativeDomains.reason
      if (contextId < 0 && realm === undefined) return 'Client execution context is no longer available'
    }
    if (typeof params.uniqueContextId === 'string') {
      const realm = this.realms.byUniqueContextId(params.uniqueContextId)
      if (realm?.nativeDomains.state === 'unsupported') return realm.nativeDomains.reason
      if (params.uniqueContextId.startsWith('dsh-client:') && realm === undefined) {
        return 'Client execution context is no longer available'
      }
    }
    for (const [key, value] of Object.entries(params)) {
      if (!key.endsWith('ObjectId') && key !== 'objectId') continue
      if (typeof value !== 'string') continue
      const route = this.objects.resolve(value)
      if (route?.realm.nativeDomains.state === 'unsupported') return route.realm.nativeDomains.reason
    }
    return undefined
  }

  private receiveRealm(event: InspectorRealmSessionEvent): void {
    if (event.type === 'opened') {
      if (this.enabled) {
        this.pendingAnnouncements++
        void this.announceRealm(event.session)
      }
      return
    }
    this.detachConsole(event.session.descriptor.realmId)
    this.objects.releaseRealm(event.session)
    this.destroy(event.session)
  }

  /**
   * Admit one realm to this connection, Console subscription first.
   *
   * `attachConsole` dispatches a Client realm's enable frame in this turn, before
   * the Worker replies `source/accepted` and the source starts publishing, so the
   * Client installs its Console observer ahead of its own first records.
   *
   * A realm this connection cannot observe is closed instead of announced, and
   * the failure stays inside it: one Client whose Console enable is never
   * confirmed leaves the Host realm and every sibling Client on this connection.
   * @param realm - Realm session to observe and enable.
   * @returns The realm once its Console events and Runtime state are live for
   * this connection, or undefined when it was dropped instead.
   */
  private async admitRealm(realm: InspectorRealmSession): Promise<InspectorRealmSession | undefined> {
    try {
      await Promise.all([this.attachConsole(realm), enableRuntime(realm)])
      return realm
    } catch {
      // Closing the session ends a Console subscription that did establish, so
      // this connection forgets it rather than replaying it to a closed backend.
      this.detachConsole(realm.descriptor.realmId)
      realm.close()
      return undefined
    }
  }

  private async announceRealm(realm: InspectorRealmSession): Promise<void> {
    try {
      const admitted = await this.admitRealm(realm)
      if (admitted !== undefined) this.announce(admitted)
    } finally {
      this.settleAnnouncement()
    }
  }

  private settleAnnouncement(): void {
    this.pendingAnnouncements--
    for (const listener of [...this.settledListeners]) listener()
  }

  private async attachConsole(realm: InspectorRealmSession): Promise<void> {
    if (realm.console.state === 'unsupported') return
    let subscription = this.consoleSubscriptions.get(realm.descriptor.realmId)
    if (subscription === undefined) {
      subscription = realm.console.backend.subscribe((event) => {
        if (!this.enabled) return
        this.transport.send(this.objects.consoleEvent(realm, event))
      })
      this.consoleSubscriptions.set(realm.descriptor.realmId, subscription)
    }
    try {
      await subscription
    } catch (error) {
      this.consoleSubscriptions.delete(realm.descriptor.realmId)
      throw error
    }
  }

  private detachConsole(realmId: InspectorRealmId): void {
    const subscription = this.consoleSubscriptions.get(realmId)
    if (subscription === undefined) return
    this.consoleSubscriptions.delete(realmId)
    void subscription.then(
      (dispose) => { dispose() },
      () => {
        // A subscription the realm never established retains nothing to release.
      },
    )
  }

  private detachConsoles(): void {
    for (const realmId of [...this.consoleSubscriptions.keys()]) this.detachConsole(realmId)
  }

  private announce(realm: InspectorRealmSession): void {
    if (!this.enabled || realm.context.kind !== 'synthetic' || this.announcedContexts.has(realm.context.id)) return
    this.announcedContexts.add(realm.context.id)
    this.transport.send({
      method: 'Runtime.executionContextCreated',
      params: {
        context: {
          id: realm.context.id,
          uniqueId: realm.context.uniqueId,
          origin: realm.context.origin,
          name: `Client — ${realm.descriptor.label}`,
          auxData: { isDefault: false, type: 'dsh-client', sourceId: realm.descriptor.sourceId },
        },
      },
    })
  }

  private destroy(realm: InspectorRealmSession): void {
    if (realm.context.kind !== 'synthetic' || !this.announcedContexts.delete(realm.context.id)) return
    this.transport.send({
      method: 'Runtime.executionContextDestroyed',
      params: {
        executionContextId: realm.context.id,
        executionContextUniqueId: realm.context.uniqueId,
      },
    })
  }

  private respond(request: CdpRequest, operation: () => Promise<object>): void {
    respondToCdpRequest(this.transport, request, operation)
  }

  private sendError(request: CdpRequest, message: string): void {
    this.transport.send(cdpError(request.id, -32000, message))
  }
}

async function enableRuntime(realm: InspectorRealmSession): Promise<void> {
  await runtimeBackend(realm).enable()
}

function runtimeBackend(realm: InspectorRealmSession): RuntimeBackend {
  if (realm.runtime.state === 'unsupported') throw new Error(realm.runtime.reason)
  return realm.runtime.backend
}
