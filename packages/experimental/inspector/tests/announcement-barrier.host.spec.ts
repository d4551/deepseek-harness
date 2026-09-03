/**
 * The Elements barrier that keeps a DevTools connection from learning of a node
 * before the execution context that owns it.
 *
 * The defect this pins is a single-socket-read ordering: record ingestion is
 * synchronous with the read, while the announcement rides a promise behind the
 * Client's `client-console/enabled` reply. `tests/cordis-tree.host.spec.ts` ::
 * `restores a disconnected Client tree from a new transport generation` drives a
 * real socket, which decides on its own whether one read carries both frames.
 * This suite assembles the Worker's own registry, routers, realms, and CDP
 * domain sessions and delivers the reply and the first records in one turn, so
 * the coalesced read is the case under test rather than a load artifact.
 *
 * Doubles are the boundaries this process cannot host: the source carrier that
 * would be a WebSocket to a Client, the DevTools transport that would be a
 * WebSocket to Chrome, and the Host realm, whose shipped implementation reaches
 * V8 through `connectToMainThread` and therefore runs only inside the Worker
 * thread. The Client realm, both routers, the source registry, the tree store,
 * the DOM backend, and both CDP domain sessions are the shipped ones.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { CordisDomBackend } from '../src/worker/cdp/domains/dom/model.ts'
import { CordisDomSession } from '../src/worker/cdp/domains/dom/session.ts'
import { RuntimeDomainSession } from '../src/worker/cdp/domains/runtime/session.ts'
import { InspectorRealmSessionSet } from '../src/worker/cdp/realm-sessions.ts'
import { ClientRuntimeRouter } from '../src/worker/bridge/runtime-rpc.ts'
import { ClientSourceRouter } from '../src/worker/bridge/source-rpc.ts'
import { InspectorSourceRegistry, type SourceConnection } from '../src/worker/bridge/hub.ts'
import { CordisTreeStore } from '../src/worker/inspection/cordis-store.ts'
import { InspectorRealmRegistry } from '../src/worker/inspection/realm-store.ts'
import type { InspectorRealm, InspectorRealmSession } from '../src/worker/inspection/realm.ts'
import type { RuntimeBackend } from '../src/shared/cdp/realm.ts'
import { CORDIS_TREE_TOPIC } from '../src/shared/bridge/messages/cordis.ts'
import {
  INSPECTOR_PROTOCOL_VERSION,
  type InspectorSourceDescriptor,
  type WorkerToSourceFrame,
} from '../src/shared/bridge/messages/observation.ts'
import { inspectorId } from '../src/shared/identity.ts'
import type { InspectorJsonValue } from '../src/shared/json.ts'
import type { CdpTransport } from '../src/worker/cdp/protocol.ts'

/** Frame a DevTools client would read off its socket. */
interface SentFrame {
  readonly id?: number
  readonly method?: string
  readonly result?: Record<string, unknown>
  readonly error?: { message: string }
}

/** Records what one DevTools connection is told, in delivery order. */
class RecordingTransport implements CdpTransport {
  readonly sent: SentFrame[] = []
  closed = false

  send(payload: unknown): void {
    this.sent.push(payload as SentFrame)
  }

  close(): void {
    this.closed = true
  }

  /** Method names delivered from `offset` onward, responses included. */
  methodsFrom(offset: number): string[] {
    return this.sent.slice(offset).map(frame => frame.method ?? `#response:${String(frame.id)}`)
  }

  /**
   * Settle one CDP response, failing loudly on a domain error.
   * @param id - Request id awaited on this connection.
   * @returns The response result fields.
   */
  async response(id: number): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const frame = this.sent.find(sent => sent.id === id)
      if (frame !== undefined) {
        if (frame.error !== undefined) throw new Error(`CDP request ${String(id)} failed: ${frame.error.message}`)
        return frame.result ?? {}
      }
      await new Promise((resolve) => { setTimeout(resolve, 5) })
    }
    throw new Error(`CDP request ${String(id)} was never answered`)
  }
}

/**
 * Host realm stand-in for the native V8 session the Worker thread owns.
 *
 * The registry always carries a Host realm and `Runtime.enable` opens every
 * realm, so this connection needs one that answers `enable`. Its context is
 * native, which is never announced, so it contributes nothing to the ordering
 * under test. Every operation outside that path rejects rather than inventing a
 * result no assertion here reads.
 */
class UnusedHostRuntimeBackend implements RuntimeBackend {
  enable(): Promise<void> {
    return Promise.resolve()
  }

  disable(): Promise<void> {
    return Promise.resolve()
  }

  evaluate(): never {
    return this.unavailable()
  }

  getProperties(): never {
    return this.unavailable()
  }

  callFunction(): never {
    return this.unavailable()
  }

  awaitPromise(): never {
    return this.unavailable()
  }

  globalLexicalScopeNames(): never {
    return this.unavailable()
  }

  releaseObject(): never {
    return this.unavailable()
  }

  releaseObjectGroup(): never {
    return this.unavailable()
  }

  private unavailable(): never {
    throw new Error('the announcement-barrier suite evaluates nothing in the Host realm')
  }
}

/** Host realm carrying only the native context and the enable path. */
class StubHostRealm implements InspectorRealm {
  readonly descriptor: InspectorRealm['descriptor'] = {
    realmId: inspectorId<'InspectorRealmId'>('host-realm', 'realmId'),
    sourceId: inspectorId<'InspectorSourceId'>('host-runtime', 'sourceId'),
    generation: inspectorId<'InspectorSourceGeneration'>('host-generation', 'generation'),
    kind: 'host',
    label: 'Host',
  }

  readonly context: InspectorRealm['context'] = { kind: 'native' }
  readonly capabilities: InspectorRealm['capabilities'] = {
    runtime: ['evaluate'],
    console: [],
    sources: [],
    debugger: [],
  }

  openSession(): InspectorRealmSession {
    return {
      descriptor: this.descriptor,
      context: this.context,
      runtime: { state: 'supported', backend: new UnusedHostRuntimeBackend() },
      console: { state: 'unsupported', reason: 'Host Console is owned by the Worker thread' },
      sources: { state: 'unsupported', reason: 'Host scripts are owned by the Worker thread' },
      debugger: { state: 'unsupported', reason: 'Host debugging is owned by the Worker thread' },
      nativeDomains: { state: 'unsupported', reason: 'Host native CDP is owned by the Worker thread' },
      close: () => {},
    }
  }
}

const SOURCE_ID = 'client-a'

function clientSource(generation: string): InspectorSourceDescriptor {
  return {
    sourceId: inspectorId<'InspectorSourceId'>(SOURCE_ID, 'sourceId'),
    generation: inspectorId<'InspectorSourceGeneration'>(generation, 'generation'),
    kind: 'client',
    label: 'Barrier Client',
    timeOriginMs: 0,
    capabilities: [
      { type: 'client-runtime', origin: 'https://client.invalid' },
      { type: 'client-console' },
    ],
  }
}

/** One Cordis snapshot whose single Fiber child carries `uid`. */
function treeSnapshot(revision: number, fiberUid: number): InspectorJsonValue {
  return {
    schemaVersion: 0,
    revision,
    objectRegistryId: `registry-${String(revision)}`,
    root: {
      kind: 'context',
      objectHandle: `root-${String(revision)}`,
      children: [{
        kind: 'fiber',
        uid: fiberUid,
        objectHandle: `fiber-${String(fiberUid)}`,
        children: [{ kind: 'context', objectHandle: `fiber-${String(fiberUid)}-context`, children: [] }],
      }],
    },
    truncated: false,
  }
}

/** The Worker CDP stack for one Client and one DevTools connection, minus both sockets. */
class BarrierHarness {
  readonly transport = new RecordingTransport()
  readonly workerFrames: WorkerToSourceFrame[] = []
  readonly connection: SourceConnection = {
    kind: 'client',
    send: (frame) => { this.workerFrames.push(frame) },
    close: () => { this.connectionClosed = true },
  }

  private connectionClosed = false
  private readonly trees = new CordisTreeStore({ maxNodes: 100, maxDisconnectedTrees: 1 })
  private readonly sources = new InspectorSourceRegistry([this.trees], 1_000_000, 64)
  private readonly clientRuntime = new ClientRuntimeRouter(this.sources, 10_000)
  private readonly clientSources = new ClientSourceRouter(this.sources, 10_000, 100_000, 1_000_000)
  private readonly realms = new InspectorRealmRegistry(
    new StubHostRealm(), this.clientRuntime, this.clientSources,
  )
  private readonly domBackend = new CordisDomBackend(this.trees)
  private readonly realmSessions = new InspectorRealmSessionSet(this.realms)
  readonly runtime = new RuntimeDomainSession(this.transport, this.realmSessions)
  readonly dom = new CordisDomSession(this.transport, this.domBackend, this.runtime)
  private nextRequestId = 0

  /** Open one Client source generation over the shared carrier. */
  openGeneration(generation: string): void {
    this.sources.receive(this.connection, {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/open',
      source: clientSource(generation),
      topics: [CORDIS_TREE_TOPIC],
    })
  }

  /** Publish one complete Cordis snapshot for a generation. */
  publishTree(generation: string, revision: number, fiberUid: number): void {
    this.sources.receive(this.connection, {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/replace',
      sourceId: SOURCE_ID,
      generation,
      nextSequence: revision,
      records: [{ monotonicMs: revision, topic: CORDIS_TREE_TOPIC, payload: treeSnapshot(revision, fiberUid) }],
    })
  }

  /** Answer the Worker's outstanding Console enable exactly as a Client would. */
  confirmConsoleEnable(generation: string): void {
    const enable = [...this.workerFrames].reverse()
      .find(frame => frame.t === 'client-console/enable' && frame.generation === generation)
    if (enable === undefined || enable.t !== 'client-console/enable') {
      throw new Error(`the Worker never asked generation ${generation} to enable Console`)
    }
    this.sources.receive(this.connection, {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'client-console/enabled',
      sourceId: enable.sourceId,
      generation: enable.generation,
      sessionId: enable.sessionId,
    })
  }

  /** Drop the carrier, as a closed Client socket does. */
  disconnect(): void {
    this.sources.disconnect(this.connection, 'transport closed')
  }

  /**
   * Send one CDP request through the domain that owns it.
   * @param method - CDP method name.
   * @param params - Method parameters.
   * @returns The response result fields.
   */
  async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.nextRequestId
    const request = { id, method, params }
    if (!this.dom.handle(request) && !this.runtime.handle(request)) {
      throw new Error(`no Worker domain owns ${method}`)
    }
    return await this.transport.response(id)
  }

  /** Whether the carrier was closed by a protocol rejection. */
  get carrierClosed(): boolean {
    return this.connectionClosed
  }

  close(): void {
    this.dom.close()
    this.runtime.close()
    this.realmSessions.close()
    this.realms.close()
    this.clientSources.close()
    this.clientRuntime.close()
    this.domBackend.close()
    this.sources.close()
  }
}

describe('Elements delivery behind the execution-context announcement', () => {
  let harness: BarrierHarness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('withholds a reconnect mutation that arrives in the announcement turn, then delivers it in order', async () => {
    harness = new BarrierHarness()
    harness.openGeneration('generation-1')
    harness.publishTree('generation-1', 1, 1)

    const enabled = harness.call('Runtime.enable')
    harness.confirmConsoleEnable('generation-1')
    await enabled
    const document = (await harness.call('DOM.getDocument')).root as { children?: unknown[] }
    expect(document.children).toBeDefined()
    expect(harness.transport.sent.some(frame => frame.method === 'Runtime.executionContextCreated')).toBe(true)

    harness.disconnect()
    const offset = harness.transport.sent.length

    // One socket read: the reconnect handshake, the Client's Console confirmation,
    // and the new generation's first records, with no turn boundary between them.
    harness.openGeneration('generation-2')
    expect(harness.runtime.announcementPending()).toBe(true)
    harness.confirmConsoleEnable('generation-2')
    harness.publishTree('generation-2', 1, 2)

    // The records were ingested synchronously with the read; the announcement is
    // still a queued continuation, so nothing DOM-shaped may have left yet.
    expect(harness.runtime.announcementPending()).toBe(true)
    expect(harness.transport.methodsFrom(offset).filter(method => method.startsWith('DOM.'))).toEqual([])

    await settled(() => !harness!.runtime.announcementPending())

    const methods = harness.transport.methodsFrom(offset)
    const created = methods.indexOf('Runtime.executionContextCreated')
    expect(created).toBeGreaterThanOrEqual(0)
    expect(methods.slice(0, created).filter(method => method.startsWith('DOM.'))).toEqual([])
    expect(methods.slice(created + 1).filter(method => method.startsWith('DOM.')))
      .toEqual(['DOM.childNodeRemoved', 'DOM.childNodeInserted'])
    expect(harness.carrierClosed).toBe(false)
  })

  it('discards the withheld queue when DOM.getDocument answers with the current tree', async () => {
    harness = new BarrierHarness()
    harness.openGeneration('generation-1')
    harness.publishTree('generation-1', 1, 1)

    const enabled = harness.call('Runtime.enable')
    harness.confirmConsoleEnable('generation-1')
    await enabled
    await harness.call('DOM.getDocument')

    harness.disconnect()
    harness.openGeneration('generation-2')
    harness.confirmConsoleEnable('generation-2')
    harness.publishTree('generation-2', 1, 2)
    const offset = harness.transport.sent.length

    // The response carries the tree those increments produced, so replaying them
    // afterwards would describe mutations the frontend has already applied.
    await harness.call('DOM.getDocument')
    await settled(() => !harness!.runtime.announcementPending())

    expect(harness.transport.methodsFrom(offset).filter(method => method.startsWith('DOM.'))).toEqual([])
  })

  it('reports no pending announcement once a realm this connection cannot admit is dropped', async () => {
    harness = new BarrierHarness()
    harness.openGeneration('generation-1')
    harness.publishTree('generation-1', 1, 1)

    const enabled = harness.call('Runtime.enable')
    harness.confirmConsoleEnable('generation-1')
    await enabled
    await harness.call('DOM.getDocument')

    harness.disconnect()
    const offset = harness.transport.sent.length
    harness.openGeneration('generation-2')
    harness.publishTree('generation-2', 1, 2)
    expect(harness.runtime.announcementPending()).toBe(true)
    expect(harness.transport.methodsFrom(offset).filter(method => method.startsWith('DOM.'))).toEqual([])

    // The Client never confirms Console for the new generation; dropping its
    // carrier settles the announcement it owed and releases the held changes,
    // so a connection that never admits a realm is not a stalled Elements pane.
    harness.disconnect()
    await settled(() => !harness!.runtime.announcementPending())

    const methods = harness.transport.methodsFrom(offset)
    expect(methods).not.toContain('Runtime.executionContextCreated')
    expect(methods.filter(method => method.startsWith('DOM.')))
      .toEqual(['DOM.childNodeRemoved', 'DOM.childNodeInserted'])
  })
})

/**
 * Await a condition reached by promise settlement rather than by elapsed time.
 * @param condition - Predicate re-read after each turn.
 */
async function settled(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return
    await new Promise((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error('the Worker never settled its pending announcement')
}
