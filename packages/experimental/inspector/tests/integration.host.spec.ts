/** Host-driven integration over an isolated Client fixture. */

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createContext, runInContext } from 'node:vm'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startInspector, type InspectorHandle } from '../src/host/bridge/controller.ts'
import { InspectorClientFixture } from './fixtures/client-source.host.ts'
import type { InspectorClientBootstrap } from '../src/shared/bridge/messages/control.ts'
import { INSPECTOR_PROTOCOL_VERSION } from '../src/shared/bridge/messages/observation.ts'
import { rawText } from '../src/worker/bridge/endpoint.ts'

interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly result?: Record<string, unknown>
  readonly error?: { message: string }
}

/**
 * How long a condition driven by the real Worker is given to become true.
 *
 * Every wait in this file is on a dedicated Worker, its inspector sessions, and
 * a CDP round trip over a socket. Vitest's one-second default is the wall clock
 * of an idle host, not of a loaded one, and the budget belongs to the file so a
 * new case cannot be written without it.
 */
const WORKER_ROUND_TRIP_MS = 15_000

/**
 * Wait for a Worker-driven condition on this file's budget.
 * @param check - assertion re-run until it stops throwing.
 * @returns the check's result once it passes.
 */
const waitForWorker = <T>(check: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(check, { timeout: WORKER_ROUND_TRIP_MS })

/** One sent CDP request awaiting the response carrying its id. */
interface PendingCall {
  readonly method: string
  readonly resolve: (message: CdpMessage) => void
  readonly reject: (error: Error) => void
}

/**
 * CDP client whose calls settle only on events of the connection.
 *
 * A request has three terminal conditions: the response carrying its id, a
 * closed socket, and a socket error. Elapsed time is not one of them, so the
 * lane's `testTimeout` stays the single deadline and a host too busy to answer
 * within it is reported as a slow test rather than as a CDP fault. A request
 * the socket outlives is named by {@link inFlight}.
 */
class TestCdpClient {
  private nextId = 0
  private readonly pending = new Map<number, PendingCall>()
  readonly events: CdpMessage[] = []

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(rawText(data)) as CdpMessage
      if (message.id === undefined) {
        this.events.push(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      pending.resolve(message)
    })
    socket.on('close', () => { this.abandon('Inspector CDP socket closed') })
    socket.on('error', (error: Error) => { this.abandon(`Inspector CDP socket failed: ${error.message}`) })
  }

  static async connect(url: string): Promise<TestCdpClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    return new TestCdpClient(socket)
  }

  /** Methods sent whose response has not arrived, in call order. */
  get inFlight(): readonly string[] {
    return [...this.pending.values()].map(pending => pending.method)
  }

  /**
   * Send one CDP request over this connection.
   * @param method - CDP method name.
   * @param params - Method parameters.
   * @returns The response carrying this request's id; rejects when the socket closes or fails first.
   */
  call(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    const id = ++this.nextId
    return new Promise<CdpMessage>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * Fail every outstanding request the connection can no longer answer.
   * @param reason - Terminal condition the socket reached.
   */
  private abandon(reason: string): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id)
      pending.reject(new Error(`${reason} with ${pending.method} in flight`))
    }
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>((resolve) => { this.socket.once('close', () => { resolve() }) })
    this.socket.close()
    await closed
  }
}

/**
 * Client peer that speaks the ingest protocol and never answers the Worker.
 *
 * The Worker reaches a Client only over this socket, so a peer that writes
 * nothing back is how a case observes `clientRuntimeTimeoutMs` without asking
 * the host to be fast: every `client-runtime/request` and `client-console/enable`
 * it receives can end only in that deadline. Console is an optional Client
 * capability, so a peer that omits it is admitted to a DevTools connection
 * without any Worker-to-Client round trip.
 */
class SilentClientSource {
  private constructor(private readonly socket: WebSocket) {}

  /**
   * Open one Client source generation and wait for the Worker to admit it.
   * @param bootstrap - Client ingest endpoint published by the Inspector.
   * @param options - Source label and whether this source declares Console.
   * @returns The admitted peer.
   */
  static async open(
    bootstrap: InspectorClientBootstrap,
    options: { readonly label: string; readonly console: boolean },
  ): Promise<SilentClientSource> {
    const socket = new WebSocket(bootstrap.endpoint, bootstrap.protocol)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    const admitted = new Promise<void>((resolve, reject) => {
      socket.on('message', (data) => {
        const frame = JSON.parse(rawText(data)) as { t?: string; message?: string }
        if (frame.t === 'source/accepted') resolve()
        if (frame.t === 'source/rejected') reject(new Error(`Client source rejected: ${String(frame.message)}`))
      })
    })
    socket.send(JSON.stringify({
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/open',
      source: {
        sourceId: `silent-${randomUUID()}`,
        generation: `silent-${randomUUID()}`,
        kind: 'client',
        label: options.label,
        timeOriginMs: 0,
        capabilities: [
          { type: 'client-runtime', origin: 'https://silent.invalid' },
          ...(options.console ? [{ type: 'client-console' }] : []),
        ],
      },
      topics: [],
    }))
    await admitted
    return new SilentClientSource(socket)
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    const closed = new Promise<void>((resolve) => { this.socket.once('close', () => { resolve() }) })
    this.socket.close()
    await closed
  }
}

describe('experimental Inspector real Worker', () => {
  let inspector: InspectorHandle | undefined
  let cdp: TestCdpClient | undefined
  let secondCdp: TestCdpClient | undefined
  let client: InspectorClientFixture | undefined
  let silentClient: SilentClientSource | undefined
  let server: Server | undefined

  afterEach(async () => {
    const stranded = [...cdp?.inFlight ?? [], ...secondCdp?.inFlight ?? []]
    await client?.close()
    client = undefined
    await silentClient?.close()
    silentClient = undefined
    await cdp?.close()
    cdp = undefined
    await secondCdp?.close()
    secondCdp = undefined
    await inspector?.close()
    inspector = undefined
    if (server !== undefined) await new Promise<void>((resolve) => { server!.close(() => { resolve() }) })
    server = undefined
    // A case that spent the lane's testTimeout inside a call reaches here with
    // that request still open; reporting it after teardown names the method
    // Vitest's own timeout message cannot.
    if (stranded.length > 0) throw new Error(`Inspector CDP requests never answered: ${stranded.join(', ')}`)
  })

  it('switches between Host and Client contexts and routes Client RemoteObjects', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false, clientReconnectBaseMs: 10, clientReconnectMaxMs: 20 })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    inspector.source.publish('host/probe', { value: 1 })
    client = await InspectorClientFixture.start(inspector.endpoint.client, { label: 'Test Client' })
    await client.publish('client/probe', { value: 2 })

    await waitForWorker(async () => {
      const response = await cdp!.call('DSHInspector.getSources')
      const sources = response.result?.sources as Array<{ kind: string; topics: Record<string, number> }>
      expect(sources.find(source => source.kind === 'host')?.topics).toEqual({ 'host/probe': 1 })
      expect(sources.find(source => source.kind === 'client')?.topics).toMatchObject({ 'client/probe': 1 })
    })

    ;(globalThis as Record<string, unknown>).__inspectorHostProbe = 73
    expect((await cdp.call('Runtime.enable')).error).toBeUndefined()
    let clientContextId: number | undefined
    let clientUniqueContextId: string | undefined
    await waitForWorker(() => {
      expect(runtimeContexts(cdp!).some(context => context.name === 'Host')).toBe(true)
      const clientContext = cdp!.events
        .filter(event => event.method === 'Runtime.executionContextCreated')
        .map(event => event.params?.context as Record<string, unknown> | undefined)
        .find(context => String(context?.name).startsWith('Client —'))
      expect(clientContext).toBeDefined()
      clientContextId = clientContext?.id as number
      clientUniqueContextId = clientContext?.uniqueId as string
    })
    if (clientContextId === undefined || clientUniqueContextId === undefined) {
      throw new Error('Client execution context was not announced')
    }
    const hostEvaluated = await cdp.call('Runtime.evaluate', {
      expression: 'globalThis.__inspectorHostProbe',
      returnByValue: true,
    })
    expect(hostEvaluated.result?.result).toMatchObject({ type: 'number', value: 73 })

    await client.setGlobal('__inspectorClientProbe', { value: 17, nested: { ready: true } })
    const clientEvaluated = await cdp.call('Runtime.evaluate', {
      expression: 'globalThis.__inspectorClientProbe',
      contextId: clientContextId,
      objectGroup: 'console',
      generatePreview: true,
    })
    const clientObject = clientEvaluated.result?.result as Record<string, unknown>
    expect(clientObject).toMatchObject({ type: 'object', className: 'Object' })
    expect(String(clientObject.objectId)).toMatch(/^runtime:/u)

    const properties = await cdp.call('Runtime.getProperties', {
      objectId: clientObject.objectId,
      ownProperties: true,
    })
    const propertyRows = recordArray(properties.result?.result)
    const valueProperty = propertyRows.find(property => property.name === 'value')
    const nestedProperty = propertyRows.find(property => property.name === 'nested')
    expect(asRecord(valueProperty?.value)).toMatchObject({ type: 'number', value: 17 })
    expect(asRecord(nestedProperty?.value).type).toBe('object')

    const called = await cdp.call('Runtime.callFunctionOn', {
      objectId: clientObject.objectId,
      functionDeclaration: 'function (increment) { return this.value + increment }',
      arguments: [{ value: 5 }],
      returnByValue: true,
    })
    expect(called.result?.result).toMatchObject({ type: 'number', value: 22 })

    const hostObject = await cdp.call('Runtime.evaluate', { expression: '({ realm: "host" })' })
    const hostObjectId = asRecord(hostObject.result?.result).objectId
    expect((await cdp.call('Runtime.callFunctionOn', {
      executionContextId: clientContextId,
      functionDeclaration: 'function (value) { return value }',
      arguments: [{ objectId: hostObjectId }],
    })).error?.message).toContain('between realms')
    expect((await cdp.call('Runtime.callFunctionOn', {
      objectId: hostObjectId,
      functionDeclaration: 'function (value) { return value }',
      arguments: [{ objectId: clientObject.objectId }],
    })).error?.message).toContain('between realms')
    expect((await cdp.call('Runtime.queryObjects', {
      prototypeObjectId: clientObject.objectId,
    })).error?.message).toContain('Client realm has no native CDP transport')

    const awaited = await cdp.call('Runtime.evaluate', {
      expression: 'Promise.resolve({ realm: "client" })',
      contextId: clientContextId,
      awaitPromise: true,
      returnByValue: true,
    })
    expect(awaited.result?.result).toMatchObject({ type: 'object', value: { realm: 'client' } })

    const uniquelyRouted = await cdp.call('Runtime.evaluate', {
      expression: '6 * 7',
      uniqueContextId: clientUniqueContextId,
      returnByValue: true,
    })
    expect(uniquelyRouted.result?.result).toMatchObject({ type: 'number', value: 42 })

    expect((await cdp.call('Runtime.releaseObject', { objectId: clientObject.objectId })).error).toBeUndefined()
    expect((await cdp.call('Runtime.getProperties', { objectId: clientObject.objectId })).error).toBeDefined()

    const thrown = await cdp.call('Runtime.evaluate', {
      expression: 'throw new Error("client failure")',
      contextId: clientContextId,
    })
    expect(asRecord(thrown.result?.exceptionDetails)).toMatchObject({
      text: 'Uncaught',
      executionContextId: clientContextId,
    })

    const pendingEvaluation = cdp.call('Runtime.evaluate', {
      expression: 'new Promise(() => {})',
      contextId: clientContextId,
      awaitPromise: true,
    })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
    await client.close()
    client = undefined
    expect((await pendingEvaluation).error).toBeDefined()
    await waitForWorker(() => {
      expect(cdp!.events.some(event =>
        event.method === 'Runtime.executionContextDestroyed'
        && event.params?.executionContextId === clientContextId)).toBe(true)
    })
  })

  it('isolates Client object ids and object groups by DevTools connection', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false })
    client = await InspectorClientFixture.start(inspector.endpoint.client, { label: 'Shared Client' })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    secondCdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await Promise.all([cdp.call('Runtime.enable'), secondCdp.call('Runtime.enable')])

    const firstContext = await clientContext(cdp, 'Shared Client')
    const secondContext = await clientContext(secondCdp, 'Shared Client')
    const first = await cdp.call('Runtime.evaluate', {
      expression: '({ owner: "first" })',
      contextId: firstContext,
      objectGroup: 'console',
    })
    const second = await secondCdp.call('Runtime.evaluate', {
      expression: '({ owner: "second" })',
      contextId: secondContext,
      objectGroup: 'console',
    })
    const firstObjectId = asRecord(first.result?.result).objectId
    const secondObjectId = asRecord(second.result?.result).objectId
    expect(firstObjectId).not.toBe(secondObjectId)
    expect((await secondCdp.call('Runtime.getProperties', { objectId: firstObjectId })).error).toBeDefined()

    await cdp.close()
    cdp = undefined
    const secondProperties = await secondCdp.call('Runtime.getProperties', {
      objectId: secondObjectId,
      ownProperties: true,
    })
    const owner = recordArray(secondProperties.result?.result).find(property => property.name === 'owner')
    expect(asRecord(owner?.value).value).toBe('second')
    expect((await secondCdp.call('Runtime.releaseObjectGroup', { objectGroup: 'console' })).error).toBeUndefined()
    expect((await secondCdp.call('Runtime.getProperties', { objectId: secondObjectId })).error).toBeDefined()

    const beforeDisable = await secondCdp.call('Runtime.evaluate', {
      expression: '({ retained: true })',
      contextId: secondContext,
    })
    const disabledObjectId = asRecord(beforeDisable.result?.result).objectId
    expect((await secondCdp.call('Runtime.disable')).error).toBeUndefined()
    expect((await secondCdp.call('Runtime.enable')).error).toBeUndefined()
    expect((await secondCdp.call('Runtime.getProperties', { objectId: disabledObjectId })).error).toBeDefined()
  })

  it('cancels Client Runtime work when the Worker deadline expires', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false, clientRuntimeTimeoutMs: 20 })
    // A Client that declares Runtime without Console: admitting its realm costs
    // this connection no Worker-to-Client round trip, so nothing this case needs
    // before the deadline has to complete within the deadline it configures.
    silentClient = await SilentClientSource.open(inspector.endpoint.client, {
      label: 'Timeout Client',
      console: false,
    })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')
    const contextId = await clientContext(cdp, 'Timeout Client')

    const stalled = { expression: 'new Promise(() => {})', contextId, awaitPromise: true }
    expect((await cdp.call('Runtime.evaluate', stalled)).error?.message)
      .toContain('Client Runtime evaluate timed out after 20ms')
    // The cancelled request did not take the realm with it: a realm this
    // connection had dropped answers `is no longer available` instead.
    expect((await cdp.call('Runtime.evaluate', stalled)).error?.message)
      .toContain('Client Runtime evaluate timed out after 20ms')
    const sources = (await cdp.call('DSHInspector.getSources')).result?.sources
    expect(recordArray(sources).map(source => source.label)).toContain('Timeout Client')
  })

  it('keeps the Host realm on a connection whose Client realm never confirms its Console', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false, clientRuntimeTimeoutMs: 20 })
    // Declares Console and never confirms the enable, so the Worker's deadline is
    // the only way this connection's attach to that realm can end.
    silentClient = await SilentClientSource.open(inspector.endpoint.client, {
      label: 'Mute Client',
      console: true,
    })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)

    expect((await cdp.call('Runtime.enable')).error).toBeUndefined()
    expect(runtimeContexts(cdp).some(context => String(context.name).startsWith('Client —'))).toBe(false)

    // A native context created after the enable proves the Host realm's Runtime
    // domain is still enabled for this connection, not rolled back with the Client.
    const context = createContext({}, { name: 'Host Survives Client Context' })
    runInContext('globalThis.hostSurvivorMarker = "enabled"', context)
    let vmContextId: number | undefined
    await waitForWorker(() => {
      const created = runtimeContexts(cdp!).find(candidate => candidate.name === 'Host Survives Client Context')
      expect(created, 'the Host realm stopped announcing execution contexts').toBeDefined()
      vmContextId = created?.id as number | undefined
    })
    expect((await cdp.call('Runtime.evaluate', {
      expression: 'globalThis.hostSurvivorMarker',
      contextId: vmContextId,
      returnByValue: true,
    })).result?.result).toMatchObject({ type: 'string', value: 'enabled' })

    // The realm was dropped for this connection only; the Worker kept the source.
    const sources = (await cdp.call('DSHInspector.getSources')).result?.sources
    expect(recordArray(sources).map(source => source.label)).toContain('Mute Client')
  })

  it('preserves native Host execution-context selectors', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')
    const context = createContext({}, { name: 'Inspector VM Context' })
    runInContext('globalThis.vmMarker = "selected-vm"; let vmLexicalMarker = 1', context)

    let contextId: number | undefined
    let uniqueContextId: string | undefined
    await waitForWorker(() => {
      const created = runtimeContexts(cdp!).find(candidate => candidate.name === 'Inspector VM Context')
      contextId = created?.id as number | undefined
      uniqueContextId = created?.uniqueId as string | undefined
      expect(contextId).toBeTypeOf('number')
      expect(uniqueContextId).toBeTypeOf('string')
    })
    const evaluated = await cdp.call('Runtime.evaluate', {
      expression: 'globalThis.vmMarker',
      contextId,
      returnByValue: true,
    })
    expect(evaluated.result?.result).toMatchObject({ type: 'string', value: 'selected-vm' })
    expect((await cdp.call('Runtime.evaluate', {
      expression: 'globalThis.vmMarker',
      uniqueContextId,
      returnByValue: true,
    })).result?.result).toMatchObject({ type: 'string', value: 'selected-vm' })
    expect((await cdp.call('Runtime.callFunctionOn', {
      executionContextId: contextId,
      functionDeclaration: 'function () { return globalThis.vmMarker }',
      returnByValue: true,
    })).result?.result).toMatchObject({ type: 'string', value: 'selected-vm' })
    expect((await cdp.call('Runtime.globalLexicalScopeNames', { executionContextId: contextId })).result?.names)
      .toContain('vmLexicalMarker')
  })

  it('uses the same Runtime value model for Host and Client realms', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false })
    client = await InspectorClientFixture.start(inspector.endpoint.client, { label: 'Compatibility Client' })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')
    const clientContextId = await clientContext(cdp, 'Compatibility Client')

    for (const [name, contextId] of [['Host', undefined], ['Client', clientContextId]] as const) {
      const select = contextId === undefined ? {} : { contextId }
      const nan = await cdp.call('Runtime.evaluate', { expression: 'NaN', ...select })
      expect(nan.result?.result, name).toMatchObject({ type: 'number', unserializableValue: 'NaN' })

      const array = await cdp.call('Runtime.evaluate', {
        expression: '[1, 2]',
        objectGroup: `compat-${name}`,
        ...select,
      })
      const arrayObject = asRecord(array.result?.result)
      expect(arrayObject, name).toMatchObject({ type: 'object', subtype: 'array', className: 'Array' })
      const properties = await cdp.call('Runtime.getProperties', {
        objectId: arrayObject.objectId,
        ownProperties: true,
      })
      const first = recordArray(properties.result?.result).find(property => property.name === '0')
      expect(first, name).toMatchObject({ configurable: true, enumerable: true, writable: true })
      expect(asRecord(first?.value), name).toMatchObject({ type: 'number', value: 1 })

      const thrown = await cdp.call('Runtime.evaluate', {
        expression: 'throw new TypeError("realm-compatibility")',
        ...select,
      })
      expect(thrown.result?.result, name).toMatchObject({ type: 'object', subtype: 'error' })
      expect(thrown.result?.exceptionDetails, name).toMatchObject({ text: 'Uncaught' })

      expect((await cdp.call('Runtime.releaseObjectGroup', { objectGroup: `compat-${name}` })).error).toBeUndefined()
      expect((await cdp.call('Runtime.getProperties', { objectId: arrayObject.objectId })).error).toBeDefined()
    }

    expect((await cdp.call('Runtime.evaluate', {
      expression: '1 + 1',
      throwOnSideEffect: true,
    })).result?.result).toMatchObject({ type: 'number', value: 2 })
    expect((await cdp.call('Runtime.evaluate', {
      expression: '1 + 1',
      contextId: clientContextId,
      throwOnSideEffect: true,
    })).error?.message).toContain('does not support throwOnSideEffect')
    expect((await cdp.call('Runtime.compileScript', {
      expression: '1 + 1',
      sourceURL: 'client-eval.js',
      persistScript: true,
      executionContextId: clientContextId,
    })).error?.message).toContain('Client realm has no native CDP transport')
  })

  it('forwards Client Console objects through isolated realm sessions', async () => {
    inspector = await startInspector({ port: 0, captureFetch: false })
    client = await InspectorClientFixture.start(inspector.endpoint.client, { label: 'Console Client' })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    secondCdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await Promise.all([cdp.call('Runtime.enable'), secondCdp.call('Runtime.enable')])
    const firstContext = await clientContext(cdp, 'Console Client')
    const secondContext = await clientContext(secondCdp, 'Console Client')
    const value = { owner: 'client-console' }
    const marker = 'client-console-event'
    await client.log(value, marker)
    let firstEvent: CdpMessage | undefined
    let secondEvent: CdpMessage | undefined
    await waitForWorker(() => {
      firstEvent = consoleEvent(cdp!, firstContext, marker)
      secondEvent = consoleEvent(secondCdp!, secondContext, marker)
      expect(firstEvent).toBeDefined()
      expect(secondEvent).toBeDefined()
    })
    const firstObjectId = asRecord(recordArray(firstEvent!.params?.args)[0]).objectId
    const secondObjectId = asRecord(recordArray(secondEvent!.params?.args)[0]).objectId
    expect(firstObjectId).toBeTypeOf('string')
    expect(secondObjectId).toBeTypeOf('string')
    expect(firstObjectId).not.toBe(secondObjectId)
    expect((await secondCdp.call('Runtime.getProperties', { objectId: firstObjectId })).error).toBeDefined()

    const secondProperties = await secondCdp.call('Runtime.getProperties', {
      objectId: secondObjectId,
      ownProperties: true,
    })
    const owner = recordArray(secondProperties.result?.result).find(property => property.name === 'owner')
    expect(asRecord(owner?.value).value).toBe('client-console')

    expect((await cdp.call('Runtime.discardConsoleEntries')).error).toBeUndefined()
    expect((await cdp.call('Runtime.getProperties', { objectId: firstObjectId })).error).toBeDefined()
    expect((await secondCdp.call('Runtime.getProperties', { objectId: secondObjectId })).error).toBeUndefined()
  })

  it('projects a chunked Client bundle as read-only Debugger source', async () => {
    const sourceText = `const clientSourceMarker = 42\n/*${'x'.repeat(150_000)}*/\n`
    const sourceMap = JSON.stringify({ version: 3, sources: ['client/index.ts'], mappings: 'AAAA' })
    const sourceUrl = 'http://client.test/plugins/inspector/client.js?rev=test'
    const sourceMapUrl = 'http://client.test/plugins/inspector/client.js.map?rev=test'
    inspector = await startInspector({ port: 0, captureFetch: false, maxClientSourceBytes: 1_000_000 })
    client = await InspectorClientFixture.start(inspector.endpoint.client, {
      label: 'Source Client',
      sourceCatalog: { sourceText, sourceMap, sourceUrl, sourceMapUrl },
    })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')
    const contextId = await clientContext(cdp, 'Source Client')
    expect((await cdp.call('Debugger.enable')).error).toBeUndefined()

    let script: CdpMessage | undefined
    await waitForWorker(() => {
      script = cdp!.events.find(event => event.method === 'Debugger.scriptParsed'
        && event.params?.url === sourceUrl)
      expect(script).toBeDefined()
    })
    expect(script?.params).toMatchObject({
      executionContextId: contextId,
      sourceMapURL: sourceMapUrl,
      hash: 'test',
      isModule: false,
      length: sourceText.length,
    })
    const scriptId = script?.params?.scriptId
    expect(scriptId).toBeTypeOf('string')
    await expect(cdp.call('Debugger.getScriptSource', { scriptId })).resolves.toMatchObject({
      result: { scriptSource: sourceText },
    })
    await expect(cdp.call('Debugger.searchInContent', {
      scriptId,
      query: 'clientSourceMarker',
      caseSensitive: true,
    })).resolves.toMatchObject({
      result: { result: [{ lineNumber: 0, lineContent: 'const clientSourceMarker = 42' }] },
    })
    expect((await cdp.call('Debugger.setBreakpointByUrl', { url: sourceUrl, lineNumber: 0 })).error?.message)
      .toContain('Client native debugging is unavailable')
    expect((await cdp.call('Debugger.setBreakpointByUrl', {
      urlRegex: 'client\\.js',
      lineNumber: 0,
    })).error?.message).toContain('Client native debugging is unavailable')
    expect((await cdp.call('Debugger.setBreakpointByUrl', {
      scriptHash: 'test',
      lineNumber: 0,
    })).error?.message).toContain('Client native debugging is unavailable')
    expect((await cdp.call('Debugger.evaluateOnCallFrame', {
      callFrameId: 'client:unsupported-frame',
      expression: '1',
    })).error?.message).toContain('Client native debugging is unavailable')
  }, 15_000)

  it('projects full Host fetch data through the Network domain', async () => {
    server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        response.writeHead(201, { authorization: 'response-secret', 'content-type': 'application/json' })
        response.end(JSON.stringify({ body }))
      })
    })
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as import('node:net').AddressInfo).port
    inspector = await startInspector({ port: 0 })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Network.enable')

    const response = await fetch(`http://127.0.0.1:${String(port)}/capture?secret=query`, {
      method: 'POST',
      headers: { authorization: 'Bearer request-secret' },
      body: 'request-body',
    })
    expect(await response.json()).toEqual({ body: 'request-body' })

    let started: CdpMessage | undefined
    await waitForWorker(() => {
      started = cdp!.events.find(event =>
        event.method === 'Network.requestWillBeSent'
        && String((event.params?.request as Record<string, unknown> | undefined)?.url).includes('/capture'))
      expect(started).toBeDefined()
      expect(cdp!.events.some(event =>
        event.method === 'Network.loadingFinished'
        && event.params?.requestId === started!.params?.requestId)).toBe(true)
    })
    const request = started!.params?.request as Record<string, unknown>
    expect(request.url).toBe(`http://127.0.0.1:${String(port)}/capture?secret=query`)
    expect(request.headers).toMatchObject({ authorization: 'Bearer request-secret' })
    const requestId = started!.params?.requestId
    const post = await cdp.call('Network.getRequestPostData', { requestId })
    expect(post.result?.postData).toBe('request-body')
    const body = await cdp.call('Network.getResponseBody', { requestId })
    expect(Buffer.from(String(body.result?.body), 'base64').toString('utf8')).toBe('{"body":"request-body"}')
  })

  it('streams later Host fetch response chunks to an opted-in CDP connection', async () => {
    const continueResponse = Promise.withResolvers<true>()
    const firstChunk = 'data: first\n\n'
    const laterChunk = 'event: update\nid: 2\ndata: second\ndata: line\n\n'
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write(firstChunk)
      void continueResponse.promise.then(() => { response.end(laterChunk) })
    })
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as import('node:net').AddressInfo).port
    inspector = await startInspector({ port: 0 })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Network.enable')

    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/events`)
      let requestId: string | undefined
      await waitForWorker(() => {
        const received = cdp!.events.find(event =>
          event.method === 'Network.responseReceived'
          && (event.params?.response as Record<string, unknown> | undefined)?.mimeType === 'text/event-stream')
        requestId = received?.params?.requestId as string | undefined
        expect(requestId).toBeTypeOf('string')
        expect(received?.params).toMatchObject({
          type: 'EventSource',
          response: { encodedDataLength: -1 },
        })
        expect(cdp!.events.find(event =>
          event.method === 'Network.requestWillBeSent'
          && event.params?.requestId === requestId)?.params?.type).toBe('EventSource')
        expect(cdp!.events.find(event =>
          event.method === 'Network.eventSourceMessageReceived'
          && event.params?.requestId === requestId)?.params).toMatchObject({
          eventName: 'message',
          eventId: '1',
          data: 'first',
        })
        expect(cdp!.events.some(event =>
          event.method === 'Network.dataReceived'
          && event.params?.requestId === requestId)).toBe(true)
      })
      if (requestId === undefined) throw new Error('SSE request was not observed')

      const streaming = await cdp.call('Network.streamResourceContent', { requestId })
      expect(Buffer.from(String(streaming.result?.bufferedData), 'base64').toString('utf8')).toBe(firstChunk)
      const laterEventOffset = cdp.events.length
      continueResponse.resolve(true)
      expect(await response.text()).toBe(firstChunk + laterChunk)

      await waitForWorker(() => {
        expect(cdp!.events.some(event =>
          event.method === 'Network.loadingFinished'
          && event.params?.requestId === requestId)).toBe(true)
        const streamed = cdp!.events.slice(laterEventOffset)
          .filter(event => event.method === 'Network.dataReceived'
            && event.params?.requestId === requestId
            && typeof event.params?.data === 'string')
          .map(event => Buffer.from(String(event.params!.data), 'base64'))
        expect(Buffer.concat(streamed).toString('utf8')).toBe(laterChunk)
        expect(cdp!.events.slice(laterEventOffset).find(event =>
          event.method === 'Network.eventSourceMessageReceived'
          && event.params?.requestId === requestId)?.params).toMatchObject({
          eventName: 'update',
          eventId: '2',
          data: 'second\nline',
        })
      })

      const body = await cdp.call('Network.getResponseBody', { requestId })
      expect(Buffer.from(String(body.result?.body), 'base64').toString('utf8')).toBe(firstChunk + laterChunk)
    } finally {
      continueResponse.resolve(true)
    }
  })

  it('keeps captured EventSource data readable when the caller aborts after response headers', async () => {
    const eventStream = 'data: first\n\ndata: [DONE]\n\n'
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write(eventStream)
    })
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => { resolve() }) })
    const port = (server.address() as import('node:net').AddressInfo).port
    inspector = await startInspector({ port: 0 })
    cdp = await TestCdpClient.connect(inspector.endpoint.webSocketDebuggerUrl)
    await cdp.call('Network.enable')
    const abort = new AbortController()

    const response = await fetch(`http://127.0.0.1:${String(port)}/aborted-events`, { signal: abort.signal })
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('SSE response did not expose a body')
    expect(Buffer.from((await reader.read()).value ?? []).toString('utf8')).toBe(eventStream)

    let requestId: string | undefined
    await waitForWorker(() => {
      const received = cdp!.events.find(event =>
        event.method === 'Network.responseReceived'
        && String((event.params?.response as Record<string, unknown> | undefined)?.url).includes('/aborted-events'))
      requestId = received?.params?.requestId as string | undefined
      expect(requestId).toBeTypeOf('string')
      expect(cdp!.events.filter(event =>
        event.method === 'Network.eventSourceMessageReceived'
        && event.params?.requestId === requestId).map(event => event.params?.data)).toEqual(['first', '[DONE]'])
    })
    abort.abort()

    await waitForWorker(() => {
      expect(cdp!.events.some(event =>
        event.method === 'Network.loadingFinished'
        && event.params?.requestId === requestId)).toBe(true)
    })
    expect(cdp.events.some(event =>
      event.method === 'Network.loadingFailed'
      && event.params?.requestId === requestId)).toBe(false)
    const body = await cdp.call('Network.getResponseBody', { requestId })
    expect(Buffer.from(String(body.result?.body), 'base64').toString('utf8')).toBe(eventStream)
    expect(body.result?.dshInspectorTruncated).toBe(true)
    expect(String(body.result?.dshInspectorCaptureError)).toContain('AbortError')
  })
})

async function clientContext(client: TestCdpClient, label: string): Promise<number> {
  let contextId: number | undefined
  // Named, not merely prefixed: `Runtime.enable` replays every live realm, so a
  // Client another case left connected is announced here too, and taking the
  // first `Client —` context makes this wait on a realm that will never log.
  const expected = `Client — ${label}`
  await waitForWorker(() => {
    const context = runtimeContexts(client).find(candidate => candidate.name === expected)
    expect(context, `no execution context named ${expected}`).toBeDefined()
    contextId = context?.id as number
  })
  if (contextId === undefined) throw new Error(`Client execution context ${expected} was not announced`)
  return contextId
}

function runtimeContexts(client: TestCdpClient): Readonly<Record<string, unknown>>[] {
  return client.events
    .filter(event => event.method === 'Runtime.executionContextCreated')
    .map(event => asRecord(event.params?.context))
}

function consoleEvent(client: TestCdpClient, contextId: number, marker: string): CdpMessage | undefined {
  return client.events.find((event) => {
    if (event.method !== 'Runtime.consoleAPICalled' || event.params?.executionContextId !== contextId) return false
    const args = event.params.args
    return Array.isArray(args) && args.some(argument => asRecord(argument).value === marker)
  })
}

function recordArray(value: unknown): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) throw new Error('expected an array of records')
  return value.map(asRecord)
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a record')
  return value as Readonly<Record<string, unknown>>
}
