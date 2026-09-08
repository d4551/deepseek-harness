import { expect, it } from 'vitest'
import { TeamActivity } from '../src/activity.ts'
import { TeamId } from '../src/types.ts'

const TEAM = TeamId('activity-team')

it('subscribes before the initial frame and coalesces changes during consumption', async () => {
  const activity = new TeamActivity()
  const controller = new AbortController()
  const iterator = activity.changes(TEAM, controller.signal)[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ value: 0, done: false })
  activity.notify(TEAM)
  activity.notify(TEAM)
  activity.notify(TEAM)
  expect(await iterator.next()).toEqual({ value: 3, done: false })
  const next = iterator.next()
  activity.notify(TEAM)
  expect(await next).toEqual({ value: 4, done: false })
  controller.abort()
  expect(await iterator.next()).toEqual({ value: undefined, done: true })
})

it('isolates teams and removes an aborted subscriber without closing its peers', async () => {
  const activity = new TeamActivity()
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = activity.changes(TEAM, firstController.signal)[Symbol.asyncIterator]()
  const second = activity.changes(TEAM, secondController.signal)[Symbol.asyncIterator]()
  await first.next()
  await second.next()
  const firstWait = first.next()
  const secondWait = second.next()
  firstController.abort()
  expect(await firstWait).toEqual({ value: undefined, done: true })
  activity.notify(TeamId('different-team'))
  activity.notify(TEAM)
  expect(await secondWait).toEqual({ value: 1, done: false })
  secondController.abort()
  expect(await second.next()).toEqual({ value: undefined, done: true })
})

it('releases pending readers on shutdown and ends later subscriptions', async () => {
  const activity = new TeamActivity()
  const controller = new AbortController()
  const stream = activity.changes(TEAM, controller.signal)[Symbol.asyncIterator]()
  await stream.next()
  const pending = stream.next()
  activity.close()
  expect(await pending).toEqual({ value: undefined, done: true })
  const later = activity.changes(TEAM, controller.signal)[Symbol.asyncIterator]()
  expect(await later.next()).toEqual({ value: undefined, done: true })
})

it('rejects a subscription already cancelled by its caller', () => {
  const controller = new AbortController()
  const reason = new Error('Conversation changed')
  controller.abort(reason)
  expect(() => new TeamActivity().changes(TEAM, controller.signal)).toThrow(reason)
})

it('rejects overlapping reads and releases a pending read on iterator return', async () => {
  const activity = new TeamActivity()
  const controller = new AbortController()
  const iterator = activity.changes(TEAM, controller.signal)
  await iterator.next()
  const pending = iterator.next()
  await expect(iterator.next()).rejects.toThrow('already has a pending read')
  expect(await iterator.return?.()).toEqual({ value: undefined, done: true })
  expect(await pending).toEqual({ value: undefined, done: true })
  activity.notify(TEAM)
  expect(await iterator.next()).toEqual({ value: undefined, done: true })
})
