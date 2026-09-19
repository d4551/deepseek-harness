/** Browser implementation of the Cordis timer Service. */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context extends Pick<ClientTimerService, 'interval' | 'timeout' | 'throttle' | 'debounce' | 'setTimeout' | 'setInterval'> {
    /** Browser timer Service used by the mixed-in Context helpers. */
    timer: ClientTimerService
  }
}

type TimerArguments = [delay: number] | [callback: () => void, delay: number]

/** Values a Promise reject arm from Fiber-owned timer disposal may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/** Cancel pending timer work; await the result to observe completion of owned cleanup. */
export type TimerDisposer = () => void | Promise<void>

/** Schedule callback arguments without returning its result; dispose cancels pending work. */
export type Scheduled<Args extends unknown[]> = ((...args: Args) => void) & { dispose: TimerDisposer }

/** Browser timer Service whose pending work belongs to the calling Fiber. */
export class ClientTimerService extends Service {
  /** Register the Service and mix its lifecycle-safe helpers onto Context. */
  constructor(ctx: Context) {
    super(ctx, 'timer')
    ctx.mixin('timer', ['timeout', 'interval', 'throttle', 'debounce', 'setTimeout', 'setInterval'])
  }

  /**
   * Run a callback once through {@link timeout}.
   * @param callback - Work to run after the delay.
   * @param delay - Delay in milliseconds.
   * @returns Disposer that cancels the pending callback early.
   * @deprecated Use `ctx.timeout()` instead.
   */
  setTimeout(callback: () => void, delay: number): TimerDisposer {
    return this.timeout(callback, delay)
  }

  /**
   * Run a callback repeatedly through {@link interval}.
   * @param callback - Work to run on each tick.
   * @param delay - Interval in milliseconds.
   * @returns Disposer that stops the interval early.
   * @deprecated Use `ctx.interval()` instead.
   */
  setInterval(callback: () => void, delay: number): TimerDisposer {
    return this.interval(callback, delay)
  }

  /**
   * Run a callback once after a delay.
   * @param callback - work to run.
   * @param delay - delay in milliseconds.
   * @returns disposer that cancels the callback.
   */
  timeout(callback: () => void, delay: number): TimerDisposer
  /**
   * Wait for a delay.
   * @param delay - delay in milliseconds.
   * @returns promise resolved after the delay; rejects if the calling Fiber is disposed first.
   */
  timeout(delay: number): Promise<void>
  timeout(...args: TimerArguments): TimerDisposer | Promise<void> {
    if (args.length === 2) {
      const [callback, delay] = args
      const dispose = this.ctx.effect(() => {
        const timer = globalThis.setTimeout(() => {
          Promise.resolve(dispose()).then(undefined, (reason: Thrown) => { console.error(reason) })
          callback()
        }, delay)
        return () => { globalThis.clearTimeout(timer) }
      }, 'ctx.timeout()')
      return dispose
    }

    const [delay] = args
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const dispose = this.ctx.effect(() => {
      const timer = globalThis.setTimeout(resolve, delay)
      return () => {
        globalThis.clearTimeout(timer)
        reject(new Error('Context has been disposed'))
      }
    }, 'ctx.timeout()')
    return promise.then(async () => {
      await dispose()
    }, async (reason: Thrown) => {
      await dispose()
      throw reason
    })
  }

  /**
   * Run a callback repeatedly.
   * @param callback - work to run on each tick.
   * @param delay - interval in milliseconds.
   * @returns disposer that stops the interval.
   */
  interval(callback: () => void, delay: number): TimerDisposer
  /**
   * Iterate over timer ticks.
   * @param delay - interval in milliseconds.
   * @returns async iterator of ticks. Its `throw()` keeps an Error's identity;
   * an omitted reason becomes an Error, and other values become a TypeError with the original cause.
   * Disposing the calling Fiber rejects pending and subsequent `next()` calls.
   */
  interval<R = unknown>(delay: number): AsyncIterableIterator<void, R, void>
  interval(...args: TimerArguments): TimerDisposer | AsyncIterableIterator<void, unknown, void> {
    if (args.length === 2) {
      const [callback, delay] = args
      return this.ctx.effect(() => {
        const timer = globalThis.setInterval(callback, delay)
        return () => { globalThis.clearInterval(timer) }
      }, 'ctx.interval()')
    }

    const [delay] = args
    let done: { kind: 'return'; value: unknown } | { kind: 'throw'; reason: Error } | undefined
    let nextTask: PromiseWithResolvers<IteratorResult<void, unknown>> | undefined
    const dispose = this.ctx.effect(() => {
      const timer = globalThis.setInterval(() => {
        nextTask?.resolve({ done: false, value: undefined })
      }, delay)
      return () => {
        globalThis.clearInterval(timer)
        if (done !== undefined) return
        done = { kind: 'throw', reason: new Error('Context has been disposed') }
        nextTask?.reject(done.reason)
      }
    }, 'ctx.interval()')
    return {
      next: () => {
        if (done === undefined) return (nextTask = Promise.withResolvers<IteratorResult<void, unknown>>()).promise
        if (done.kind === 'return') return Promise.resolve({ done: true, value: done.value })
        return Promise.reject(done.reason)
      },
      return: async (value: unknown) => {
        if (done === undefined) done = { kind: 'return', value }
        nextTask?.resolve({ done: true, value })
        await dispose()
        return { done: true, value }
      },
      throw: async (input: unknown = new Error('Timer iteration interrupted')) => {
        const reason = input instanceof Error ? input : new TypeError('Timer iterator throw() requires an Error', { cause: input })
        if (done === undefined) done = { kind: 'throw', reason }
        nextTask?.reject(reason)
        await dispose()
        return { done: true, value: undefined }
      },
      [Symbol.asyncIterator]() {
        return this
      },
    } satisfies AsyncIterableIterator<void, unknown, void>
  }

  /** Build a delayed wrapper whose pending callback belongs to the calling Fiber. */
  private schedule<Args extends unknown[]>(
    label: string,
    trigger: (args: Args, disposed: boolean) => ReturnType<typeof globalThis.setTimeout> | undefined,
    disposed = false,
  ): Scheduled<Args> {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    const dispose = this.ctx.effect(() => () => {
      disposed = true
      globalThis.clearTimeout(timer)
    }, label)
    const scheduled = (...args: Args): void => {
      globalThis.clearTimeout(timer)
      timer = trigger(args, disposed)
    }
    return Object.assign(scheduled, { dispose })
  }

  /**
   * Return a throttled function whose timer is disposed with the calling Fiber.
   * @param callback - Function to throttle.
   * @param delay - Minimum interval between calls in milliseconds.
   * @param noTrailing - Whether to omit a delayed trailing call.
   * @returns Throttled function with an early disposer.
   */
  throttle<Args extends unknown[]>(callback: (...args: Args) => void, delay: number, noTrailing?: boolean): Scheduled<Args> {
    let lastCall = -Infinity
    const execute = (...args: Args): void => {
      lastCall = Date.now()
      callback(...args)
    }
    return this.schedule<Args>('ctx.throttle()', (args, disposed) => {
      const remaining = delay - Date.now() + lastCall
      if (remaining <= 0) {
        execute(...args)
      } else if (!disposed) {
        return globalThis.setTimeout(execute, remaining, ...args)
      }
    }, noTrailing)
  }

  /**
   * Return a debounced function whose timer is disposed with the calling Fiber.
   * @param callback - Function to debounce.
   * @param delay - Quiet period in milliseconds.
   * @returns Debounced function with an early disposer.
   */
  debounce<Args extends unknown[]>(callback: (...args: Args) => void, delay: number): Scheduled<Args> {
    return this.schedule<Args>('ctx.debounce()', (args, disposed) => {
      if (disposed) return
      return globalThis.setTimeout(callback, delay, ...args)
    })
  }
}

/**
 * Install the browser timer Service on one Client composition.
 * @param ctx - Client context that owns the Service and mixed-in helpers.
 * @returns Nothing after registering the Service.
 */
export function provideClientTimer(ctx: Context): void {
  new ClientTimerService(ctx)
}
