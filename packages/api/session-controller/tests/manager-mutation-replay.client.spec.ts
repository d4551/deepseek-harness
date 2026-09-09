import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionSummary } from '../src/types.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, fakeRemote, ok, remoteOk } from './fake-api.client.ts'

it('reconciles closed subagent catalogs after missing a completion while disconnected', async () => {
  const parent = SessionId('reconnected-parent')
  const child = SessionId('reconnected-child')
  const api = new FakeApiClient()
  let running = true
  api.onSubagentList = async () => remoteOk({
    parentAvailable: true,
    entries: [{ kind: 'child', id: child, mode: 'continuable', label: 'worker',
      activity: running ? 'running' : 'inactive', hasChildren: false }],
  })
  const manager = new SessionManager(fakeRemote(api))
  await manager.refreshSubagents(parent)
  expect(manager.getListSnapshot().subagentsByParent[parent]?.entries[0]).toMatchObject({ activity: 'running' })
  running = false
  manager.handleConnected()
  await manager.refreshSubagents(parent)
  expect(api.callsOf('subagents.list')).toEqual([parent, parent])
  expect(manager.getListSnapshot().subagentsByParent[parent]?.entries[0]).toMatchObject({ activity: 'inactive' })
  await manager.dispose()
})

it('preserves the swarm list for repeated events and still observes completion edges', async () => {
  const parent = SessionId('steady-parent')
  const child = SessionId('steady-child')
  const absent = SessionId('absent-worker')
  const manager = new SessionManager(fakeRemote(), parent)
  const summary = { sessionId: child, updatedAt: 1, running: false, blank: false }
  manager.handleSessionAdded({ ...summary, sessionId: parent })
  manager.handleSessionAdded(summary)
  await Promise.resolve()
  const before = manager.getListSnapshot()
  let notifications = 0
  const unsubscribe = manager.subscribe(() => { notifications += 1 })

  for (let round = 0; round < 32; round += 1) {
    manager.handleSessionStatus(child, false)
    manager.handleSessionActivity(child, 1)
    manager.handleSessionAdded(summary)
    manager.handleSessionRemoved(absent)
    expect(manager.getListSnapshot()).toBe(before)
    await Promise.resolve()
  }
  expect(notifications).toBe(0)
  manager.handleSessionStatus(child, true)
  manager.handleSessionStatus(child, false)
  await Promise.resolve()
  expect(notifications).toBe(1)
  expect(manager.getListSnapshot().items.find(item => item.sessionId === child))
    .toMatchObject({ running: false, completed: true })
  expect(manager.getListSnapshot().current).toBe(parent)
  unsubscribe()
  await manager.dispose()
})

it('replays an early worker transition over a list that has not arrived yet', async () => {
  const child = SessionId('arriving-worker')
  const response = Promise.withResolvers<SessionSummary[]>()
  const api = new FakeApiClient()
  api.onList = async () => ok({ items: await response.promise })
  const manager = new SessionManager(fakeRemote(api))
  const refresh = manager.refreshList()
  manager.handleSessionStatus(child, true)
  response.resolve([{ sessionId: child, updatedAt: 1, running: false, blank: true }])
  await refresh
  expect(manager.getListSnapshot().items).toMatchObject([
    { sessionId: child, running: true, blank: false, completed: false },
  ])
  await manager.dispose()
})

it('publishes parent unavailability when an already idle durable worker is removed', async () => {
  const worker = SessionId('idle-parent-worker')
  const manager = new SessionManager(fakeRemote())
  manager.handleSessionAdded({ sessionId: worker, updatedAt: 1, running: false, blank: false, origin: 'subagent' })
  await manager.refreshSubagents(worker)
  expect(manager.getListSnapshot().subagentsByParent[worker]?.parentAvailable).toBe(true)
  await Promise.resolve()
  let notifications = 0
  const unsubscribe = manager.subscribe(() => { notifications += 1 })
  manager.handleSessionRemoved(worker)
  expect(manager.getListSnapshot().subagentsByParent[worker]?.parentAvailable).toBe(false)
  await Promise.resolve()
  expect(notifications).toBe(1)
  unsubscribe()
  await manager.dispose()
})

it('removes jobs when their session is absent from the conversation list', async () => {
  const worker = SessionId('unlisted-job-owner')
  const manager = new SessionManager(fakeRemote())
  manager.handleControlFrame({
    type: 'jobs', sessionId: worker,
    jobs: [{ id: JobId('shell-1'), kind: 'shell', label: 'build', status: 'running', startedAt: 1 }],
  })
  expect(manager.getListSnapshot().jobsBySession[worker]).toHaveLength(1)
  manager.handleSessionRemoved(worker)
  expect(manager.getListSnapshot().jobsBySession[worker]).toBeUndefined()
  await manager.dispose()
})

it('publishes a new title carried by a repeated session addition', async () => {
  const worker = SessionId('retitled-worker')
  const manager = new SessionManager(fakeRemote())
  const summary = { sessionId: worker, updatedAt: 1, running: false, blank: false }
  manager.handleSessionAdded(summary)
  expect(manager.getListSnapshot().items[0]?.title).toBeUndefined()
  manager.handleSessionAdded({ ...summary, projections: { asOfSeq: 2, values: { title: 'Worker results' } } })
  expect(manager.getListSnapshot().items[0]?.title).toBe('Worker results')
  await manager.dispose()
})
