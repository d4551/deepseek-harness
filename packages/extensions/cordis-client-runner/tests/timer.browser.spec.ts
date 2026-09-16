import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { ClientTimerService } from '../src/client/timer.ts'

async function boot() {
  const root = new Context()
  onTestFinished(async () => { await root.fiber.dispose() })
  await root.plugin(ClientTimerService)
  const captured = Promise.withResolvers<ClientTimerService>()
  const consumer = root.plugin({
    inject: ['timer'],
    apply(ctx: Context) {
      captured.resolve(ctx.timer)
    },
  })
  await consumer
  return { root, consumer, timer: await captured.promise }
}

it('owns pending timeout and interval work in the calling plugin', async () => {
  const { timer, consumer, root } = await boot()
  await timer.timeout(0)
  const waiting = timer.timeout(60_000)
  const ticks = timer.interval(60_000)
  const next = ticks.next()
  const timeoutRejected = expect(waiting).rejects.toThrow('Context has been disposed')
  const intervalRejected = expect(next).rejects.toThrow('Context has been disposed')
  await consumer.dispose()
  await timeoutRejected
  await intervalRejected
  await expect(ticks.next()).rejects.toThrow('Context has been disposed')
  await root.timer.timeout(0)
})

it('returns a pending tick immediately and preserves the returned value', async () => {
  const { timer } = await boot()
  const ticks = timer.interval<{ completed: boolean }>(60_000)
  const pending = ticks.next()
  const value = { completed: true }
  const order: string[] = []
  const observed = pending.then((result) => {
    order.push('pending')
    expect(result).toEqual({ done: true, value })
    expect(result.value).toBe(value)
  })
  if (!ticks.return) throw new Error('Timer iterator must expose return()')
  const returned = ticks.return(value).then((result) => {
    order.push('return')
    expect(result).toEqual({ done: true, value })
  })
  await observed
  await returned
  expect(order).toEqual(['pending', 'return'])
  expect((await ticks.next()).value).toBe(value)
})

it('preserves an Error supplied to interval throw()', async () => {
  const { timer } = await boot()
  const ticks = timer.interval(60_000)
  const reason = new Error('consumer stopped')
  const rejected = expect(ticks.next()).rejects.toBe(reason)
  if (!ticks.throw) throw new Error('Timer iterator must expose throw()')
  expect(await ticks.throw(reason)).toEqual({ done: true, value: undefined })
  await rejected
  await expect(ticks.next()).rejects.toBe(reason)
})

it('reports invalid interval failure values with their original cause', async () => {
  const { timer } = await boot()
  const ticks = timer.interval(60_000)
  const cause = { interrupted: true }
  const rejected = expect(ticks.next()).rejects.toMatchObject({
    name: 'TypeError',
    message: 'Timer iterator throw() requires an Error',
    cause,
  })
  if (!ticks.throw) throw new Error('Timer iterator must expose throw()')
  expect(await ticks.throw(cause)).toEqual({ done: true, value: undefined })
  await rejected
  await expect(ticks.next()).rejects.toBeInstanceOf(TypeError)
})

it('defines an Error when interval throw() has no reason', async () => {
  const { timer } = await boot()
  const ticks = timer.interval(60_000)
  const rejected = expect(ticks.next()).rejects.toThrow('Timer iteration interrupted')
  if (!ticks.throw) throw new Error('Timer iterator must expose throw()')
  expect(await ticks.throw()).toEqual({ done: true, value: undefined })
  await rejected
  await expect(ticks.next()).rejects.toThrow('Timer iteration interrupted')
})

it('delivers native ticks and cancels callback timers through their disposers', async () => {
  const { timer } = await boot()
  const callbackTick = Promise.withResolvers<undefined>()
  let calls = 0
  const cancelInterval = timer.interval(() => {
    calls++
    callbackTick.resolve(undefined)
  }, 0)
  await callbackTick.promise
  await cancelInterval()
  const stoppedAt = calls
  let cancelledCalled = false
  const cancelTimeout = timer.timeout(() => { cancelledCalled = true }, 0)
  await cancelTimeout()
  const completed = Promise.withResolvers<undefined>()
  timer.timeout(() => { completed.resolve(undefined) }, 0)
  await completed.promise
  expect(calls).toBe(stoppedAt)
  expect(cancelledCalled).toBe(false)
  const ticks = timer.interval(0)
  expect(ticks[Symbol.asyncIterator]()).toBe(ticks)
  expect(await ticks.next()).toEqual({ done: false, value: undefined })
  if (!ticks.return) throw new Error('Timer iterator must expose return()')
  await ticks.return()
})

it('preserves callback arguments while debounce replaces pending work', async () => {
  const { timer } = await boot()
  const observed = Promise.withResolvers<[string, number]>()
  const calls: [string, number][] = []
  const debounced = timer.debounce((name: string, count: number) => {
    calls.push([name, count])
    observed.resolve([name, count])
  }, 0)
  debounced('first', 1)
  debounced('last', 2)
  expect(await observed.promise).toEqual(['last', 2])
  expect(calls).toEqual([['last', 2]])
  await debounced.dispose()
  debounced('retired', 3)
  await timer.timeout(0)
  expect(calls).toEqual([['last', 2]])
})

it('retains typed leading and trailing throttle calls and owns cancellation', async () => {
  const { timer, consumer } = await boot()
  const trailing = Promise.withResolvers<[string, number]>()
  const calls: [string, number][] = []
  const throttled = timer.throttle((name: string, count: number) => {
    calls.push([name, count])
    if (name === 'last') trailing.resolve([name, count])
  }, 25)
  throttled('first', 1)
  throttled('last', 2)
  expect(await trailing.promise).toEqual(['last', 2])
  expect(calls).toEqual([['first', 1], ['last', 2]])
  throttled('cancelled', 3)
  await throttled.dispose()
  const onlyLeading: string[] = []
  const leading = timer.throttle((value: string) => { onlyLeading.push(value) }, 60_000, true)
  leading('first')
  leading('second')
  await consumer.dispose()
  expect(onlyLeading).toEqual(['first'])
  expect(calls).toEqual([['first', 1], ['last', 2]])
})
