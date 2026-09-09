import { expect, it } from 'vitest'
import { observeTeamActivity } from '../src/client/observe-team.ts'
import { TeamActivity } from '../../../subagent/agent-team/src/activity.ts'
import { TeamId } from '../../../subagent/agent-team/src/types.ts'

it('cancels an outstanding view read when the panel closes', async () => {
  const activity = new TeamActivity()
  const controller = new AbortController()
  const started = Promise.withResolvers<AbortSignal>()
  const reason = new Error('Panel closed during discovery')
  const observed = observeTeamActivity(
    signal => activity.changes(TeamId('closing-discovery'), signal),
    (signal) => {
      started.resolve(signal)
      return new Promise<boolean>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(reason) }, { once: true })
      })
    },
    controller.signal,
  )
  const result = expect(observed).rejects.toBe(reason)
  const signal = await started.promise
  controller.abort(reason)
  await result
  expect(signal.aborted).toBe(true)
  expect(signal.reason).toBe(reason)
})

it('denies source admission when the caller has already cancelled', async () => {
  const controller = new AbortController()
  const reason = new Error('Panel closed')
  controller.abort(reason)
  let admitted = false
  await expect(observeTeamActivity((signal) => {
    admitted = true
    return new TeamActivity().changes(TeamId('cancelled'), signal)
  }, () => Promise.resolve(true), controller.signal)).rejects.toBe(reason)
  expect(admitted).toBe(false)
})

it('cancels admission when the activity source throws synchronously', async () => {
  const signals: AbortSignal[] = []
  const failure = new Error('Source admission failed')
  await expect(observeTeamActivity((signal) => {
    signals.push(signal)
    throw failure
  }, () => Promise.resolve(true), new AbortController().signal)).rejects.toBe(failure)
  expect(signals[0]?.aborted).toBe(true)
})

it('disposes an iterator whose next method throws synchronously', async () => {
  let closed = false
  const failure = new Error('Next failed')
  const source: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]() { return this },
    next() { throw failure },
    return() {
      closed = true
      return Promise.resolve({ value: undefined, done: true })
    },
  }
  await expect(observeTeamActivity(() => source, () => Promise.resolve(true), new AbortController().signal))
    .rejects.toBe(failure)
  expect(closed).toBe(true)
})

it('reports synchronous disposal failures after the source ends', async () => {
  const failure = new Error('Disposal failed')
  const source: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]() { return this },
    next() { return Promise.resolve({ value: undefined, done: true }) },
    return() { throw failure },
  }
  await expect(observeTeamActivity(() => source, () => Promise.resolve(true), new AbortController().signal))
    .rejects.toBe(failure)
})

it('propagates a failed view read and cancels the activity subscription', async () => {
  const activity = new TeamActivity()
  const controller = new AbortController()
  const failure = new Error('Team view unavailable')
  const signals: AbortSignal[] = []
  await expect(observeTeamActivity((signal) => {
    signals.push(signal)
    return activity.changes(TeamId('view-failure'), signal)
  }, () => Promise.reject(failure), controller.signal)).rejects.toBe(failure)
  expect(signals).toHaveLength(1)
  expect(signals[0]?.aborted).toBe(true)
})

it('reports a pending read failure even when the activity source has ended', async () => {
  const failure = new Error('Last view failed')
  const read = Promise.withResolvers<boolean>()
  const completed = Promise.withResolvers<undefined>()
  const observed = observeTeamActivity(async function* () {
    yield 0
    completed.resolve(undefined)
  }, () => read.promise, new AbortController().signal)
  const result = expect(observed).rejects.toBe(failure)
  await completed.promise
  read.reject(failure)
  await result
})

it('preserves an activity failure together with a failed outstanding read', async () => {
  const activityFailure = new Error('Activity disconnected')
  const readFailure = new Error('Outstanding read failed')
  const read = Promise.withResolvers<boolean>()
  const ended = Promise.withResolvers<undefined>()
  const observed = observeTeamActivity(async function* () {
    yield 0
    ended.resolve(undefined)
    throw activityFailure
  }, () => read.promise, new AbortController().signal)
  const result = expect(observed).rejects.toMatchObject({ errors: [activityFailure, readFailure] })
  await ended.promise
  read.reject(readFailure)
  await result
})
