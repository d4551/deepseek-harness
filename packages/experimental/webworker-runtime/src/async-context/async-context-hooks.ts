/**
 * Global hook layer for the ALS shim: capture the async context where a callback
 * is REGISTERED and restore it where the callback RUNS. Together with the folding
 * stack in `./async-hooks.ts` this gives the worker two kinds of coverage —
 * `await` inside a boundary keeps its store because the boundary's stack entry is
 * still open, and work handed to the platform (`.then`, `queueMicrotask`, timers,
 * `fetch`) keeps its store because it was captured at registration.
 *
 * Patched here: `Promise.prototype.then` and `queueMicrotask` and `fetch`. Node's
 * `catch`/`finally` are specified to invoke `then` on the receiver, so they inherit
 * the patch instead of needing their own (`als-check.ts` proves it). The worker's
 * `setTimeout`/`setInterval`/`setImmediate` are bound in `./timers-global.ts`, and
 * the host's `process.nextTick` shim is built on `queueMicrotask`, so both arrive
 * here too.
 *
 * Two properties the patches keep:
 * - the values stay native promises — a handler is wrapped, never the chain, so
 *   `then` still returns what the original returned;
 * - an empty handler slot stays empty (`.then(undefined, onRejected)` must not
 *   grow a fulfilled handler, or a rejection would be swallowed).
 *
 * Not covered (structural): native `async`/`await` resumption is invisible to user
 * code, so the folding stack remains what carries a store across an `await`.
 */
import { bindAsyncContext, captureAsyncContext, captureNativePromiseThen, runWithAsyncContext } from '../node/builtin_modules/implemented/async_hooks.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

function bindSlot<T, R>(
  handler: ((value: T) => R) | null | undefined,
  snapshot: ReturnType<typeof captureAsyncContext>,
): ((value: T) => R) | null | undefined {
  if (typeof handler !== 'function') return handler
  return (value: T) => runWithAsyncContext(snapshot, () => handler(value))
}

let installed = false

/**
 * Patch the platform registration points. Idempotent; call once from the worker
 * entry before the host tree boots.
 */
export function installAsyncContextHooks(): void {
  if (installed) return
  installed = true

  const nativeThen = captureNativePromiseThen()
  const continueNative = <T, R1, R2>(
    promise: Promise<T>,
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: Thrown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> => {
    const continued: unknown = nativeThen.call(promise, onFulfilled, onRejected)
    if (!(continued instanceof Promise)) {
      throw new Error('Promise.prototype.then did not return a Promise')
    }
    return continued
  }
  const promisePrototype: object = Promise.prototype
  let thenName: string | undefined
  for (const name of Object.getOwnPropertyNames(promisePrototype)) {
    if (name === 'then') {
      thenName = name
      break
    }
  }
  if (thenName === undefined) {
    throw new Error('Promise.prototype.then is missing')
  }
  // A browser has no async-context tracking, so registration points are where a
  // store can be captured at all — patching them is the point of this module.
  const patchedThen = function patchedThen<T, R1, R2>(
    this: Promise<T>,
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: Thrown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    const snapshot = captureAsyncContext()
    if (snapshot === undefined) {
      return continueNative(this, onFulfilled, onRejected)
    }
    return continueNative(
      this,
      bindSlot(onFulfilled, snapshot),
      bindSlot(onRejected, snapshot),
    )
  }
  Object.defineProperty(promisePrototype, thenName, {
    configurable: true,
    writable: true,
    value: patchedThen,
  })

  const nativeQueueMicrotask = globalThis.queueMicrotask.bind(globalThis)
  globalThis.queueMicrotask = (callback: VoidFunction): void => {
    nativeQueueMicrotask(bindAsyncContext(callback))
  }

  const nativeFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const snapshot = captureAsyncContext()
    if (snapshot === undefined) return nativeFetch(input, init)
    // Bind the response continuation to the call site, for consumers that hand
    // the promise on before attaching handlers. `nativeThen` keeps the chain native.
    return continueNative(
      nativeFetch(input, init),
      (response: Response) => runWithAsyncContext(snapshot, () => response),
      (reason: Thrown) => runWithAsyncContext(snapshot, () => { throw reason }),
    )
  })
}
