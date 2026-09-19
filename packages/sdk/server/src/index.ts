/**
 * SDK-facing JSON-RPC plugin over stdio. The selected dsh profile decides
 * whether to load it; see the single-launch Agent Note and package README.
 * Stdout is reserved for protocol frames, so the tree must not load a stdout logger.
 * This plugin answers `shutdown`, disposes the complete root runtime, and exits with its outcome; the app bin
 * owns EOF and signal exits. Keep named plugin exports with no default export so
 * Loader `unwrapExports` preserves `name`, `inject`, `Config`, and `apply`.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import { inspect } from 'node:util'
import Schema from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from './server.ts'

export { HarnessSdkJsonRpcServer } from './server.ts'
export type { HarnessSdkJsonRpcServerOptions } from './server.ts'

export const name = 'sdk-jsonrpc-server'
// Only the agent factory is required; initialize reads the optional LLM seam with ctx.get().
export const inject = ['agents']

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/**
 * Human text for a refused flush, dispose, or shutdown report.
 * @param reason - the Thrown the reject arm delivered.
 * @returns the Error message, primitive text, or object tag.
 */
function thrownMessage(reason: Thrown): string {
  if (reason instanceof Error) return reason.message
  switch (typeof reason) {
    case 'string': return reason
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(reason)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (reason === null) return 'null'
      return Object.prototype.toString.call(reason)
  }
}

/** Exhaustive typeof map from a catch or settlement value onto Thrown. */
function thrown(value: unknown): Thrown {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'undefined':
    case 'object':
    case 'function':
      return value
  }
}

/** JSON-RPC deployment config plus runtime-only test hooks. */
export interface JsonRpcConfig {
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  /** Transport input override; production uses `process.stdin`. */
  input?: Readable
  /** Transport output override; production uses `process.stdout`. */
  output?: Writable
  /** Process-exit override; production uses `process.exit`. */
  exit?: (code: number) => void
  /** Terminal failure sink; production writes the complete error to stderr. */
  reportError?: (error: Error) => void | Promise<void>
}

export const Config: Schema<JsonRpcConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
})

function reportStderr(error: Error): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write(`${inspect(error, { depth: null, colors: false, customInspect: false })}\n`, (failure) => {
      if (failure) reject(failure)
      else resolve()
    })
  })
}

/**
 * Serve SDK requests over the configured streams. Effect disposal shuts down
 * SDK-created agents and closes the transport. A `shutdown` response is flushed
 * before the root runtime is disposed and the process exits with its outcome; the app bin
 * owns root-context disposal for EOF and signals.
 */
export function apply(ctx: Context, config: JsonRpcConfig): void {
  // Cordis applies the schema default before invoking the plugin.
  const resolvedConfig = config as JsonRpcConfig & { maxTokensAsSuccess: boolean }
  // Protocol shutdown owns the complete runtime process, so it must await the
  // root lifecycle (including persistence) before exiting.
  const rootFiber = ctx.root.fiber
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const input = config.input ?? process.stdin
  /* v8 ignore next -- production stdio wiring; tests always inject the runtime hooks */
  const output = config.output ?? process.stdout
  /* v8 ignore next -- production exit wiring; tests always inject the runtime hooks */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })
  const reportError = config.reportError ?? reportStderr

  const transport = new JsonRpcLineTransport(input, output)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
  })

  // Share one exit task so racing shutdown requests cannot dispose the root or
  // exit the process more than once.
  let exitTask: Promise<void> | undefined
  const failures: Error[] = []
  const retainFailure = (reason: Thrown): void => {
    const error = reason instanceof Error ? reason : new Error(thrownMessage(reason), { cause: reason })
    if (!failures.includes(error)) failures.push(error)
  }
  const disposeAndExit = (): void => {
    exitTask ??= (async () => {
      const flushed = await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      for (const outcome of flushed) {
        if (outcome.status === 'rejected') retainFailure(thrown(outcome.reason))
      }
      const disposed = await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      for (const outcome of disposed) {
        if (outcome.status === 'rejected') retainFailure(thrown(outcome.reason))
      }
      const joined = await Promise.allSettled([Promise.resolve().then(() => rootFiber.await())])
      for (const outcome of joined) {
        if (outcome.status === 'rejected') retainFailure(thrown(outcome.reason))
      }
      transport.close()
      const drained = await transport.closed
      if (drained instanceof AggregateError) retainFailure(drained)
      const [firstFailure] = failures
      if (firstFailure !== undefined) {
        const error = failures.length === 1 ? firstFailure : new AggregateError(failures, 'SDK transport shutdown failed')
        const reported = await Promise.allSettled([Promise.resolve().then(() => reportError(error))])
        for (const outcome of reported) {
          if (outcome.status === 'rejected') retainFailure(thrown(outcome.reason))
        }
      }
      exit(failures.length === 0 ? 0 : 1)
    })()
  }
  const closingObserved = transport.closing.then(({ kind, reason }) => {
    if (kind === 'failure') {
      retainFailure(reason)
      disposeAndExit()
    }
  })

  transport.onRequest(async (method, params) => {
    // `initialize` is the SDK's readiness boundary. This plugin can activate
    // before async sibling Loader entries (for example an MCP client's initial
    // tool discovery), so do not advertise a ready runtime until the complete
    // current tree has settled. Loader settlement joins entry imports, fiber
    // lifecycle work, and synchronous effect registration; no scheduler delay
    // is part of readiness. A hand-built context without Loader remains
    // immediately usable.
    if (method === 'initialize') {
      await ctx.get('loader')?.await()
    }
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      // Run after the handler result is written; the task then flushes, disposes, and exits.
      setImmediate(disposeAndExit)
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      const outcomes = await Promise.allSettled([server.shutdown()])
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') retainFailure(thrown(outcome.reason))
      }
      transport.close()
      await closingObserved
      const drained = await transport.closed
      if (drained instanceof AggregateError) retainFailure(drained)
      if (outcomes.some(outcome => outcome.status === 'rejected')) {
        throw new AggregateError(failures, 'SDK server disposal failed')
      }
    }
  }, 'jsonrpc.serve')
}
