/**
 * One language-server instance: a connection plus the initialize handshake, the serialized abortable
 * query queue, the transient `didOpen`→request→`didClose` lifecycle, and bounded teardown. One
 * instance owns one `(provider id, canonical workspace)` process. Queries serialize through a single
 * queue so a cancellation that fails to stop the server can terminate it without killing unrelated
 * work; distinct instances run in parallel.
 * @module @deepseek-ai/dsh-lsp-stdio/instance
 */

import { LspError } from '@deepseek-ai/dsh-lsp'
import type {
  LspOperation,
  LspProviderQuery,
  LspQueryResult,
} from '@deepseek-ai/dsh-lsp'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { abortable, abortError } from './abort.ts'
import { LspConnection } from './connection.ts'
import { finishLspOperation } from './outcome.ts'
import type { ConnectionSpawner, ConnectionSpec, ConnectionWriter } from './connection.ts'
import type { HostSource } from './host.ts'
import type { WireInitializeResult, WireServerCapabilities } from './protocol.ts'
import {
  negotiatePositionEncoding,
  normalizeHover,
  normalizeLocations,
  requestMethod,
  supportsOperation,
  supportsTransientOpen,
} from './translate.ts'

/** Everything an instance needs beyond the connection spec. */
export interface InstanceSpec extends ConnectionSpec {
  /** Canonical workspace file URI supplied by the filesystem provider. */
  readonly workspaceUri: string
  /** Static `initialize` options forwarded to the server. */
  readonly initializationOptions: unknown
  /** Graceful `shutdown`/`exit` budget before escalation (ms). */
  readonly shutdownTimeoutMs: number
}

/** The attempted protocol shutdown and the proven process-tree cleanup. */
export interface LspTerminationOutcome {
  /** Exact protocol shutdown outcome, including a deadline or transport failure. */
  readonly gracefulShutdown: PromiseSettledResult<void>
  /** Published only after the subprocess provider confirms whole-tree exit. */
  readonly processTreeExited: true
}

/**
 * A single initialized server process. Not exported as a provider — the provider single-flights and
 * pools these. `query()` serializes; `dispose()` rejects queued work and tears the process down.
 */
export class LspInstance {
  private readonly connection: LspConnection
  private capabilities: WireServerCapabilities | undefined
  /** The serialization tail: each query awaits the prior one, so lifecycles never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  /** The one teardown transaction shared by abort, failure, and explicit disposal. */
  private teardownPromise: Promise<void> | undefined
  private terminationResult: LspTerminationOutcome | undefined
  /** Set once the process closes, so the pool can synchronously skip a dead instance. */
  private processClosed = false
  /** The observed close includes the synchronous liveness publication. */
  private readonly closed: Promise<PromiseSettledResult<void>>
  /** Retains the handshake outcome until a query or teardown joins it. */
  private readonly ready: Promise<PromiseSettledResult<void>>

  /**
   * @param spec - the launch, initialize, and teardown parameters.
   * @param spawner - the subprocess seam's spawn function.
   * @param writer - optional connection writer used by transport conformance tests.
   */
  constructor(private readonly spec: InstanceSpec, spawner: ConnectionSpawner, writer?: ConnectionWriter) {
    this.connection = new LspConnection(spec, spawner, (method, params) => this.answerServerRequest(method, params), writer)
    this.ready = Promise.allSettled([this.initialize()]).then(([outcome]) => outcome)
    this.closed = Promise.allSettled([this.connection.closed]).then(([outcome]) => {
      this.processClosed = true
      return outcome
    })
  }

  /** Synchronous liveness check: true once the process has closed or the instance was disposed. */
  get dead(): boolean {
    return this.processClosed || this.disposed || this.connection.failed
  }

  /** Completed shutdown evidence; absent until whole-tree cleanup succeeds. */
  get terminationOutcome(): LspTerminationOutcome | undefined {
    return this.terminationResult
  }

  /**
   * Test whether a caught query error came from this instance's transport.
   * @param error - error caught by the provider.
   * @returns `true` only for the connection's retained fatal transport cause.
   */
  isTransportFailure(error: unknown): boolean {
    return this.connection.failedWith(error)
  }

  /**
   * Run one query through the serialized queue.
   * @param request - the resolved provider query.
   * @param source - the pre-validated, already-read host source (the provider reads before spawning).
   * @param signal - optional cancellation for this query's full lifecycle.
   * @returns the normalized result.
   */
  query(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    // Serialize behind prior work, but observe abort DURING the queue wait too: if an earlier query
    // hangs (e.g. a signal-less service caller), a later tool's timeout must still be able to give up
    // rather than block on the shared tail forever.
    const run = this.finishQuery(abortable(this.queue, signal)
      .then(() => this.runQuery(request, source, signal)))
    // Keep the tail alive regardless of this query's outcome so the next caller still serializes. The
    // tail follows the ACTUAL prior work (this.queue), not the abortable view, so a caller giving up
    // on the wait does not deserialize the queue.
    this.queue = Promise.allSettled([this.queue, run])
    return run
  }

  private async finishQuery(work: Promise<LspQueryResult>): Promise<LspQueryResult> {
    const [result] = await Promise.allSettled([work])
    if (result.status === 'rejected' && this.isTransportFailure(result.reason)) {
      const [cleanup] = await Promise.allSettled([this.startTeardown()])
      return finishLspOperation(result, cleanup)
    }
    return finishLspOperation(result)
  }

  private async initialize(): Promise<void> {
    const initializeResult = await this.connection.request('initialize', {
      // A subprocess provider may run in another PID namespace or machine;
      // the host PID would let the server monitor an unrelated process.
      processId: null,
      rootUri: this.spec.workspaceUri,
      workspaceFolders: [{ uri: this.spec.workspaceUri, name: 'workspace' }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.spec.initializationOptions,
    }) as WireInitializeResult
    const capabilities = initializeResult.capabilities
    // An omitted encoding defaults to utf-16; any other value is a protocol error we reject here.
    negotiatePositionEncoding(capabilities.positionEncoding)
    this.capabilities = capabilities
    await this.connection.notify('initialized', {})
  }

  private async runQuery(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new LspError('LSP instance was disposed', 'LSP_DISPOSED')
    if (signal?.aborted) throw abortError(signal)
    // Observe abort during the handshake wait, and never pool a poisoned instance: if the wait ends
    // in failure — an abort on a still-pending handshake, OR `initialize` rejecting (utf-8
    // negotiation, malformed result) without the process exiting — tear the instance down so a
    // permanently-rejecting/pending `ready` can't make every later query for this workspace fail.
    const [waited] = await Promise.allSettled([abortable(this.ready, signal)])
    const ready = waited.status === 'fulfilled' ? waited.value : waited
    if (ready.status === 'rejected') {
      const [cleanup] = await Promise.allSettled([this.startTeardown()])
      finishLspOperation(ready, cleanup)
    }
    const capabilities = this.capabilities
    if (capabilities === undefined) throw new Error('LSP instance is not initialized')
    if (!supportsOperation(capabilities, request.operation)) {
      throw new LspError(`server does not support ${request.operation}`, 'LSP_UNSUPPORTED_OPERATION')
    }
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new LspError('server does not support the transient textDocument/didOpen this host requires', 'LSP_UNSUPPORTED_OPERATION')
    }

    const uri = source.fileUrl
    if (signal?.aborted) throw abortError(signal)
    const [opened] = await Promise.allSettled([abortable(this.connection.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: request.languageId, version: 1, text: source.text },
    }), signal)])
    if (opened.status === 'rejected') {
      const [cleanup] = await Promise.allSettled([this.startTeardown()])
      finishLspOperation(opened, cleanup)
    }
    const [result] = await Promise.allSettled([
      this.sendRequest(request.operation, uri, request.position, signal)
        .then(payload => this.normalize(request.operation, payload)),
    ])
    const [cleanup] = await Promise.allSettled([
      this.dead ? this.startTeardown() : this.closeDocument(uri),
    ])
    return finishLspOperation(result, cleanup)
  }

  private async closeDocument(uri: string): Promise<void> {
    using cleanupDeadline = deadline(undefined, this.spec.shutdownTimeoutMs, 'LSP_DOCUMENT_CLOSE')
    const [closed] = await Promise.allSettled([
      abortable(this.connection.notify('textDocument/didClose', { textDocument: { uri } }), cleanupDeadline.signal),
    ])
    if (closed.status === 'rejected') {
      const [cleanup] = await Promise.allSettled([this.startTeardown()])
      finishLspOperation(closed, cleanup)
    }
  }

  private async sendRequest(
    operation: LspOperation,
    uri: string,
    position: LspProviderQuery['position'],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const params = {
      textDocument: { uri },
      position: { line: position.line, character: position.character },
      // findReferences always includes declarations: the caller gets no flag and impact analysis
      // never omits the defining site.
      ...(operation === 'findReferences' ? { context: { includeDeclaration: true } } : {}),
    }
    const requestId = this.connection.peekNextId()
    const send = this.connection.request(requestMethod(operation), params)
    if (signal === undefined) return send
    return this.raceAbort(send, requestId, signal)
  }

  /**
   * Race a pending request against abort. On abort, send `$/cancelRequest` and give the server a
   * bounded grace to acknowledge; if it does not settle in time, invalidate and tear down the
   * instance so the still-active request cannot overlap the next queued query's document lifecycle.
   */
  private async raceAbort(send: Promise<unknown>, requestId: number, signal: AbortSignal): Promise<unknown> {
    const [result] = await Promise.allSettled([abortable(send, signal)])
    if (result.status === 'fulfilled' || !signal.aborted) return finishLspOperation(result)
    using grace = deadline(undefined, this.spec.killGraceMs, 'LSP_CANCEL_GRACE')
    const [canceled] = await Promise.allSettled([abortable(this.connection.cancel(requestId), grace.signal)])
    if (canceled.status === 'rejected') {
      const [cleanup] = await Promise.allSettled([this.startTeardown()])
      return finishLspOperation(result, canceled, cleanup)
    }
    const [acknowledged] = await Promise.allSettled([abortable(Promise.allSettled([send]), grace.signal)])
    if (acknowledged.status === 'rejected') {
      const [cleanup] = await Promise.allSettled([this.startTeardown()])
      return finishLspOperation(result, cleanup)
    }
    return finishLspOperation(result)
  }

  private normalize(operation: LspOperation, payload: unknown): LspQueryResult {
    if (operation === 'hover') {
      return { kind: 'hover', hover: normalizeHover(payload) }
    }
    // The filesystem provider owns URI syntax for the execution platform, which may differ from the
    // harness host. Preserve that coordinate through rendering instead of reparsing `spec.cwd` there.
    return { kind: 'locations', locations: normalizeLocations(payload), resolvedWorkspaceUri: this.spec.workspaceUri }
  }

  private answerServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'workspace/configuration') {
      // Answer every requested item with the one static configuration value.
      if (params === null || typeof params !== 'object' || !('items' in params) || !Array.isArray(params.items)) {
        return Promise.reject(new Error('workspace/configuration requires an items array'))
      }
      return Promise.resolve(params.items.map(() => this.spec.configuration))
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) {
      // Accept lifecycle bookkeeping requests with an empty result; we register nothing dynamic.
      return Promise.resolve(null)
    }
    if (method === 'workspace/applyEdit') {
      // This host never applies edits or runs commands.
      return Promise.reject(new Error('workspace/applyEdit is not permitted by this host'))
    }
    return Promise.reject(new Error(`unsupported server request: ${method}`))
  }

  /**
   * Reject queued work, attempt graceful `shutdown`/`exit`, then escalate SIGTERM→SIGKILL, awaiting
   * process close so nothing outlives disposal.
   */
  async dispose(): Promise<void> {
    await this.startTeardown()
  }

  /** Publish disposal once and make every caller await the same quiescence boundary. */
  private startTeardown(): Promise<void> {
    this.disposed = true
    this.teardownPromise ??= this.tearDown()
    return this.teardownPromise
  }

  private async tearDown(): Promise<void> {
    using shutdownDeadline = deadline(undefined, this.spec.shutdownTimeoutMs, 'LSP_SHUTDOWN')
    const [shutdown] = await Promise.allSettled([this.gracefulShutdown(shutdownDeadline.signal)])
    await this.forceTerminate()
    this.terminationResult = { gracefulShutdown: shutdown, processTreeExited: true }
  }

  /** Best-effort LSP `shutdown`/`exit`, including process close, bounded by `signal`. */
  private async gracefulShutdown(signal: AbortSignal): Promise<void> {
    await abortable(this.connection.request('shutdown', null), signal)
    await abortable(this.connection.notify('exit', null), signal)
    const closed = await abortable(this.closed, signal)
    finishLspOperation(closed)
  }

  /**
   * Terminate the tree (the seam escalates SIGTERM→`killGraceMs`→SIGKILL),
   * then await leader and helper exit. The awaits are unbounded on purpose:
   * the seam's escalation already committed to SIGKILL, so quiescence — not
   * another timer — is the postcondition disposal owes its callers.
   */
  private async forceTerminate(): Promise<void> {
    this.connection.terminate()
    const [closed, initialized, tree] = await Promise.allSettled([
      this.closed,
      this.ready,
      this.connection.waitForProcessTreeExit(),
    ])
    const closedOutcome = closed.status === 'fulfilled' ? closed.value : closed
    const exited = finishLspOperation(tree, closedOutcome, initialized)
    if (!exited) throw new Error('LSP subprocess provider did not confirm whole-tree exit')
  }
}

/** Server→client request methods this host acknowledges with an empty result (no dynamic registration). */
const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

/**
 * The client capabilities advertised at `initialize`: UTF-16 positions, workspace folders and
 * configuration, markdown/plaintext hover, and link support for definition/implementation. No
 * dynamic registration; the server's returned capabilities are authoritative.
 */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const
