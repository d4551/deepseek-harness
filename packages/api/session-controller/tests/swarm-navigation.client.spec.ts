import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentCatalog, SubagentListEntry } from '@deepseek-ai/dsh-subagent/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, fakeRemote, remoteOk } from './fake-api.client.ts'

const parent = SessionId('swarm-parent')
const child = SessionId('swarm-child')
const sibling = SessionId('swarm-sibling')

afterEach(() => { vi.useRealTimers() })

it.each<{ name: string; entries: readonly SubagentListEntry[] | undefined }>([
  { name: 'an unread catalog', entries: undefined },
  { name: 'an absent child', entries: [member(sibling)] },
  { name: 'a damaged child', entries: [{ kind: 'diagnostic', id: child, reason: 'corrupt' }] },
  {
    name: 'a different conversation mode',
    entries: [{ kind: 'child', id: child, mode: 'one-shot', activity: 'inactive', hasChildren: false }],
  },
])('rejects $name without changing the conversation or opening transport', async ({ entries }) => {
  const api = new FakeApiClient()
  api.onSubagentList = () => Promise.resolve(remoteOk({ entries: entries ?? [], parentAvailable: true }))
  const manager = new SessionManager(fakeRemote(api), parent)
  manager.handleSessionAdded({ sessionId: parent, updatedAt: 1, running: false, blank: false })
  if (entries !== undefined) await manager.refreshSubagents(parent)
  const before = manager.getListSnapshot()
  const calls = api.callsOf('subagents.list').length

  expect(() => {
    manager.selectSubagent({ parentSessionId: parent, childSessionId: child, mode: 'continuable' })
  }).toThrow(`sessions.selectSubagent: ${child} is not a healthy catalog child`)

  expect(manager.getListSnapshot()).toBe(before)
  expect(manager.getListSnapshot().current).toBe(parent)
  expect(manager.subagentAddress(child)).toBeUndefined()
  expect(api.callsOf('subagents.list')).toHaveLength(calls)
  expect(api.callsOf('session.follow')).toEqual([])
  await manager.dispose()
})

function member(id: SessionId): SubagentListEntry {
  return {
    kind: 'child', id, mode: 'continuable', label: id,
    activity: 'inactive', hasChildren: false,
  }
}

it.each([true, false])('hydrates a child conversation with early instance creation: %s', async (early) => {
  const api = new FakeApiClient()
  let activity: 'running' | 'inactive' = 'running'
  api.onSubagentList = id => Promise.resolve(remoteOk({
    entries: id === parent ? [{
      kind: 'child', id: child, mode: 'continuable', label: 'worker',
      activity, hasChildren: false,
    }] : [],
    parentAvailable: true,
  }))
  const manager = new SessionManager(fakeRemote(api))
  if (early) manager.get(child)
  await manager.refreshSubagents(parent)
  const conversation = manager.get(child)
  manager.selectSubagent({ parentSessionId: parent, childSessionId: child, mode: 'continuable' })

  expect(manager.get(child)).toBe(conversation)
  expect(conversation.getSnapshot()).toMatchObject({ blank: false, running: true })
  activity = 'inactive'
  await manager.refreshSubagents(parent)
  expect(conversation.getSnapshot()).toMatchObject({ blank: false, running: false })
  const pending = Promise.withResolvers<SubagentCatalog>()
  api.onSubagentList = async () => remoteOk(await pending.promise)
  const refresh = manager.refreshSubagents(parent)
  manager.handleSessionStatus(child, true)
  pending.resolve({ entries: [member(child)], parentAvailable: true })
  await refresh
  expect(conversation.getSnapshot().running).toBe(true)
  await manager.dispose()
})

it('resolves each conversation from its own healthy catalog row before selection', async () => {
  const api = new FakeApiClient()
  const damaged = SessionId('damaged-child')
  const missing = SessionId('missing-child')
  api.onSubagentList = id => Promise.resolve(remoteOk({
    entries: id === parent
      ? [{ kind: 'diagnostic', id: damaged, reason: 'corrupt' }, member(sibling), member(child)]
      : [],
    parentAvailable: true,
  }))
  const manager = new SessionManager(fakeRemote(api))
  await manager.refreshSubagents(parent)
  for (const id of [child, sibling]) {
    expect(manager.navigationAddress(id)).toEqual({
      parentSessionId: parent, childSessionId: id, mode: 'continuable',
    })
    expect(manager.subagentAddress(id)).toBeUndefined()
  }
  expect(manager.navigationAddress(damaged)).toBeUndefined()
  expect(manager.navigationAddress(missing)).toBeUndefined()

  manager.select(child)
  await manager.get(child).open()
  expect(api.callsOf('session.follow')).toEqual([{
    address: { kind: 'subagent', parentSessionId: parent, childSessionId: child, mode: 'continuable' },
    maxMessages: 50,
  }])
  await manager.dispose()
})

it('discovers and opens a new sibling while a child conversation is selected', async () => {
  vi.useFakeTimers()
  const api = new FakeApiClient()
  let catalog: SubagentCatalog = { entries: [member(child)], parentAvailable: true }
  api.onSubagentList = id => Promise.resolve(remoteOk(
    id === parent ? catalog : { entries: [], parentAvailable: true },
  ))
  const manager = new SessionManager(fakeRemote(api))
  await manager.refreshSubagents(parent)
  manager.selectSubagent({ parentSessionId: parent, childSessionId: child, mode: 'continuable' })
  await manager.refreshSubagents(child)
  const before = api.callsOf('subagents.list').length

  catalog = { entries: [member(child), member(sibling)], parentAvailable: true }
  manager.handleSessionAdded({
    sessionId: sibling, parentSessionId: parent, origin: 'subagent',
    updatedAt: 1, running: false, blank: false,
  })
  manager.setSubagentCatalogOpen(parent, false)
  await vi.advanceTimersByTimeAsync(50)

  expect(api.callsOf('subagents.list')).toHaveLength(before + 1)
  expect(manager.getListSnapshot().subagentsByParent[parent]?.entries).toEqual(catalog.entries)
  manager.selectSubagent({ parentSessionId: parent, childSessionId: sibling, mode: 'continuable' })
  expect(manager.getListSnapshot().currentAddress).toEqual({
    parentSessionId: parent, childSessionId: sibling, mode: 'continuable',
  })
  await manager.get(sibling).open()
  expect(api.callsOf('session.follow')).toEqual([{
    address: { kind: 'subagent', parentSessionId: parent, childSessionId: sibling, mode: 'continuable' },
    maxMessages: 50,
  }])
  await manager.dispose()
})

it('retains the selected parent refresh when its menu closes', async () => {
  vi.useFakeTimers()
  const api = new FakeApiClient()
  const manager = new SessionManager(fakeRemote(api), parent)
  manager.handleSessionAdded({
    sessionId: child, parentSessionId: parent, origin: 'subagent',
    updatedAt: 1, running: false, blank: false,
  })
  manager.setSubagentCatalogOpen(parent, false)
  await vi.advanceTimersByTimeAsync(50)
  expect(api.callsOf('subagents.list')).toEqual([parent])
  await manager.dispose()
})

it('preserves unaffected session identities while removing obsolete list entries', async () => {
  const manager = new SessionManager(fakeRemote())
  for (const id of [parent, child, sibling]) {
    manager.handleSessionAdded({ sessionId: id, updatedAt: 1, running: false, blank: false })
  }
  const before = manager.getListSnapshot()
  manager.select(parent)
  manager.handleSessionRemoved(child)
  manager.handleSessionStatus(sibling, true)
  const after = manager.getListSnapshot()
  expect(after.items.map(entry => entry.sessionId)).toEqual([sibling, parent])
  expect(after.items[1]).toBe(before.items[2])
  expect(after.items[0]?.running).toBe(true)
  expect(after.current).toBe(parent)
  manager.handleSessionRemoved(parent)
  expect(manager.getListSnapshot().current).toBeUndefined()
  await manager.dispose()
})
