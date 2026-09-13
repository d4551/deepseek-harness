import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentCatalog } from '@deepseek-ai/dsh-subagent/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, fakeRemote, ok, remoteOk } from './fake-api.client.ts'

it('publishes a synchronous session-list failure and permits a fresh read', async () => {
  const api = new FakeApiClient()
  api.onList = () => { throw new Error('synchronous list failure') }
  const manager = new SessionManager(fakeRemote(api))
  await expect(manager.refreshList()).resolves.toBeUndefined()
  expect(manager.getListSnapshot()).toMatchObject({
    state: 'error', error: { message: 'synchronous list failure' },
  })
  api.onList = () => Promise.resolve(ok({ items: [] }))
  await manager.refreshList()
  expect(manager.getListSnapshot()).toMatchObject({ state: 'idle', phase: 'ready', error: null })
  await manager.dispose()
})

it('publishes a synchronous catalog failure and permits a fresh read', async () => {
  const parent = SessionId('synchronous-parent')
  const api = new FakeApiClient()
  api.onSubagentList = () => { throw new Error('synchronous catalog failure') }
  const manager = new SessionManager(fakeRemote(api))
  await expect(manager.refreshSubagents(parent)).resolves.toBeUndefined()
  expect(manager.getListSnapshot().subagentsByParent[parent]).toMatchObject({
    state: 'error', error: { message: 'synchronous catalog failure' },
  })
  api.onSubagentList = () => Promise.resolve(remoteOk({ entries: [], parentAvailable: true }))
  await manager.refreshSubagents(parent)
  expect(manager.getListSnapshot().subagentsByParent[parent]).toMatchObject({ state: 'ready', error: null })
  await manager.dispose()
})

it('joins selection, open-menu and reconnect reads through manager disposal', async () => {
  const parent = SessionId('background-parent')
  const child = SessionId('background-child')
  const api = new FakeApiClient()
  const list = Promise.withResolvers<Awaited<ReturnType<FakeApiClient['onList']>>>()
  const catalog = Promise.withResolvers<SubagentCatalog>()
  api.onList = () => list.promise
  api.onSubagentList = async () => remoteOk(await catalog.promise)
  const manager = new SessionManager(fakeRemote(api))
  manager.handleSessionAdded({ sessionId: parent, updatedAt: 0, running: false, blank: false })
  manager.select(parent)
  manager.setSubagentCatalogOpen(parent, true)
  manager.handleConnected()
  manager.handleSessionAdded({
    sessionId: child, parentSessionId: parent, origin: 'subagent', updatedAt: 0, running: false, blank: false,
  })
  expect(api.callsOf('subagents.list')).toEqual([parent])
  expect(api.callsOf('session.list')).toEqual([{}])
  const before = manager.getListSnapshot()
  let disposed = false
  const disposal = manager.dispose().then(() => { disposed = true })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(disposed).toBe(false)
  list.resolve(ok({ items: [] }))
  catalog.resolve({ entries: [], parentAvailable: true })
  await disposal
  expect(disposed).toBe(true)
  expect(manager.getListSnapshot()).toBe(before)
  expect(api.callsOf('subagents.list')).toEqual([parent])
  expect(api.callsOf('session.list')).toEqual([{}])
})

it.each(['list', 'catalog'])('retains an unexpected background %s publication failure for disposal', async (kind) => {
  const failure = new Error(`${kind} publication failed`)
  const reached = Promise.withResolvers<undefined>()
  const api = new FakeApiClient()
  api.onList = () => Promise.resolve(ok({
    get items(): never { reached.resolve(undefined); throw failure },
  }))
  api.onSubagentList = () => Promise.resolve(remoteOk({
    parentAvailable: true,
    get entries(): never { reached.resolve(undefined); throw failure },
  }))
  const manager = new SessionManager(fakeRemote(api))
  if (kind === 'list') manager.handleConnected()
  else manager.setSubagentCatalogOpen(SessionId('publication-parent'), true)
  await reached.promise
  await new Promise(resolve => setTimeout(resolve, 0))
  await expect(manager.dispose()).rejects.toMatchObject({
    message: 'Session manager disposal failed', errors: [failure],
  })
})

it('cancels and joins search when its manager closes', async () => {
  const api = new FakeApiClient()
  const response = Promise.withResolvers<Awaited<ReturnType<FakeApiClient['onSearch']>>>()
  api.onSearch = () => response.promise
  const manager = new SessionManager(fakeRemote(api))
  const controller = new AbortController()
  const request = manager.search('active query', controller.signal)
  let disposed = false
  const disposal = manager.dispose().then(() => { disposed = true })
  expect(api.lastSearchSignal?.aborted).toBe(true)
  expect(controller.signal.aborted).toBe(false)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  expect(disposed).toBe(false)

  response.resolve(ok({ items: [], hasMore: false }))
  await Promise.all([request, disposal])
  expect(disposed).toBe(true)
  await expect(manager.search('closed query', controller.signal)).rejects.toThrow()
  expect(api.callsOf('session.search')).toEqual([{ query: 'active query' }])
})

it.each<{ operation: 'create' | 'fork' }>([{ operation: 'create' }, { operation: 'fork' }])(
  'joins $operation without publishing its result after disposal', async ({ operation }) => {
    const parent = SessionId('mutation-parent')
    const child = SessionId('mutation-child')
    const api = new FakeApiClient()
    const response = Promise.withResolvers<Awaited<ReturnType<FakeApiClient['onCreate']>>>()
    api.onCreate = () => response.promise
    api.onFork = () => response.promise
    const manager = new SessionManager(fakeRemote(api))
    const before = manager.getListSnapshot()
    const request = operation === 'create' ? manager.create() : manager.fork({ sessionId: parent })
    let disposed = false
    const disposal = manager.dispose().then(() => { disposed = true })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(disposed).toBe(false)

    response.resolve(ok({ sessionId: child }))
    const [result] = await Promise.all([request, disposal])
    expect(result).toEqual({ ok: true, value: { sessionId: child } })
    expect(manager.getListSnapshot()).toBe(before)
    expect(disposed).toBe(true)
    await expect(manager.create()).rejects.toThrow()
    await expect(manager.fork({ sessionId: parent })).rejects.toThrow()
    expect(api.callsOf('session.create')).toHaveLength(operation === 'create' ? 1 : 0)
    expect(api.callsOf('session.fork')).toHaveLength(operation === 'fork' ? 1 : 0)
  },
)

it('joins catalog reads during disposal and prevents late publication', async () => {
  const parent = SessionId('closing-parent')
  const child = SessionId('closing-child')
  const api = new FakeApiClient()
  const response = Promise.withResolvers<SubagentCatalog>()
  api.onSubagentList = async () => remoteOk(await response.promise)
  const manager = new SessionManager(fakeRemote(api))
  const refresh = manager.refreshSubagents(parent)
  const before = manager.getListSnapshot()
  let disposed = false
  const disposal = manager.dispose().then(() => { disposed = true })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  expect(disposed).toBe(false)

  response.resolve({
    entries: [{
      kind: 'child', id: child, mode: 'continuable', label: 'worker',
      activity: 'running', hasChildren: false,
    }],
    parentAvailable: true,
  })
  await Promise.all([refresh, disposal])
  expect(disposed).toBe(true)
  expect(manager.getListSnapshot()).toBe(before)
  expect(() => manager.refreshSubagents(parent)).toThrow()
  expect(() => manager.get(child)).toThrow()
  expect(api.callsOf('subagents.list')).toEqual([parent])
})

it('joins a pending session list without publishing its closing response', async () => {
  const api = new FakeApiClient()
  const response = Promise.withResolvers<Awaited<ReturnType<FakeApiClient['onList']>>>()
  api.onList = () => response.promise
  const manager = new SessionManager(fakeRemote(api))
  const refresh = manager.refreshList()
  const before = manager.getListSnapshot()
  let disposed = false
  const disposal = manager.dispose().then(() => { disposed = true })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  expect(disposed).toBe(false)
  response.resolve(ok({ items: [] }))
  await Promise.all([refresh, disposal])
  expect(disposed).toBe(true)
  expect(manager.getListSnapshot()).toBe(before)
  expect(() => manager.refreshList()).toThrow()
  expect(api.callsOf('session.list')).toEqual([{}])
})
