import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Logger } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace/src/types.ts'
import { workspaceDomainSpec } from '@deepseek-ai/dsh-workspace/src/spec.ts'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import SessionProjectionCache from '../src/index.ts'
import { checkpointRecord, projectionCacheDomainSpec } from '../src/spec.ts'
import { recoveryProjection } from './recovery-projection.ts'
import { denyRecordOperation, preparePermissionChild, restoreRecordOperation, runPermissionChild } from './recovery-filesystem.ts'

async function environment() {
  const root = await mkdtemp(join(process.geteuid?.() === 0 ? '/tmp' : tmpdir(), 'dsh-checkpoint-recovery-'))
  const contexts: Context[] = []
  const logs: string[] = []
  onTestFinished(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const composition = join(root, 'cordis.yml')
  await writeFile(composition, [
    '- name: cordis:storage',
    '- name: cordis:storage-json',
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storage'))}`,
    '- name: cordis:storage-domain',
    '  config:',
    '    backend: json',
    '- name: cordis:sessions',
    '- name: cordis:persistence',
    '  config:',
    `    root: ${JSON.stringify(join(root, 'sessions'))}`,
    '    compression: none',
    '- name: cordis:projections',
    '- name: cordis:cache',
    '  config:',
    '    writeEveryEvents: 100',
    '    writeIntervalMs: 60000', '',
  ].join('\n'))
  const load = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.logger.exporter({ levels: { default: 3 }, export(message) { logs.push(Logger.format(this, message)) } })
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include, storage: Storage, 'storage-json': StorageJson,
      'storage-domain': StorageDomain, sessions: SessionStore,
      persistence: JsonlSessionPersistence, projections: SessionProjectionRegistry,
      cache: SessionProjectionCache,
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(composition).href } })
    await ctx.loader.await()
    expect(ctx.get('sessionProjectionCache')).toBeDefined()
    ctx.sessionProjections.register(recoveryProjection)
    return ctx
  }
  const recordPath = (id: string) => join(root, 'storage', projectionCacheDomainSpec.name, 'sessions', `${id}.json`)
  return { root, logs, load, recordPath }
}

const events: SessionEvent[] = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
]

it('drains both queued domain writes before root disposal releases the JSON backend', async () => {
  const { load, recordPath } = await environment()
  const ctx = await load()
  const domain = ctx.storageDomain.get(projectionCacheDomainSpec.name)
  if (!domain) throw new Error('projection cache domain missing after initialization')
  const table = domain.table('sessions')
  const first = { identity: { createdAt: 31 }, rows: { 'recovery/turns': { ver: 1, seq: 1, val: 1 } } }
  const second = { identity: { createdAt: 37 }, rows: { 'recovery/turns': { ver: 1, seq: 1, val: 2 } } }
  const writes = Promise.allSettled([
    table.put('first-queued', first),
    table.put('second-queued', second),
  ])
  await ctx.fiber.dispose()
  expect(await writes).toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
  ])
  expect(JSON.parse(await readFile(recordPath('first-queued'), 'utf8')))
    .toEqual({ version: projectionCacheDomainSpec.version, record: first })
  expect(JSON.parse(await readFile(recordPath('second-queued'), 'utf8')))
    .toEqual({ version: projectionCacheDomainSpec.version, record: second })
})

it('removes only schema-invalid derived records and rebuilds from durable session history after restart', async () => {
  const { root, load, recordPath, logs } = await environment()
  const first = await load()
  const damaged = { version: 0, id: SessionId('damaged'), createdAt: 17, cwd: '/work/recovery', delegationDepth: 0 }
  const neighbor = { ...damaged, id: SessionId('neighbor') }
  const workspace = await first.storageDomain.open(workspaceDomainSpec)
  const workspaceId = WorkspaceId('durable-workspace')
  const workspaceRecord = { path: damaged.cwd, title: 'Recovery workspace', sessionIds: [damaged.id, neighbor.id], createdAt: '2026-09-16', updatedAt: '2026-09-16' }
  await workspace.table('workspaces').put(workspaceId, workspaceRecord)
  await workspace.global.set({ initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] })
  for (const meta of [damaged, neighbor]) {
    await first.sessionPersistence.create(meta)
    await first.sessionPersistence.append(meta.id, events)
    expect(first.sessionProjectionCache.coldSnapshot(meta, events)).toEqual({ asOfSeq: 1, values: { 'recovery/turns': 1 } })
  }
  await first.fiber.dispose()
  expect(logs).toEqual([])
  const workspacePath = join(root, 'storage', 'workspace.json')
  const workspaceBytes = await readFile(workspacePath, 'utf8')
  const neighboringBytes = await readFile(recordPath(neighbor.id), 'utf8')
  await writeFile(recordPath(damaged.id), JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity: { createdAt: 'invalid' }, rows: {} } }))

  const recovered = await load()
  expect(recovered.sessionProjectionCache.cachedSnapshot(damaged)).toBeUndefined()
  expect(JSON.parse(await readFile(recordPath(damaged.id), 'utf8')))
    .toEqual({ version: projectionCacheDomainSpec.version, deleted: true })
  expect(await readFile(recordPath(neighbor.id), 'utf8')).toBe(neighboringBytes)
  expect(recovered.sessionProjectionCache.cachedSnapshot(neighbor)).toEqual({ asOfSeq: 1, values: { 'recovery/turns': 1 } })
  expect(logs.some(line => line.includes("domain 'session_projcache'") && line.includes("record 'damaged'") && line.includes("table 'sessions'") && line.includes('removed'))).toBe(true)
  await recovered.fiber.dispose()
  const interrupted = await load()
  expect(interrupted.sessionProjectionCache.cachedSnapshot(damaged)).toBeUndefined()
  const stored = await interrupted.sessionPersistence.load(damaged.id)
  expect(stored).toEqual({ meta: damaged, events })
  expect(interrupted.sessionProjectionCache.coldSnapshot(stored.meta, stored.events)).toEqual({ asOfSeq: 1, values: { 'recovery/turns': 1 } })
  await interrupted.fiber.dispose()

  const restarted = await load()
  expect(restarted.sessionProjectionCache.cachedSnapshot(damaged)).toEqual({ asOfSeq: 1, values: { 'recovery/turns': 1 } })
  expect(await restarted.sessionPersistence.load(damaged.id)).toEqual(stored)
  expect(await readFile(recordPath(neighbor.id), 'utf8')).toBe(neighboringBytes)
  expect(await readFile(workspacePath, 'utf8')).toBe(workspaceBytes)
  const reopenedWorkspace = await restarted.storageDomain.open(workspaceDomainSpec)
  expect(reopenedWorkspace.table('workspaces').get(workspaceId)).toEqual(workspaceRecord)
  expect(reopenedWorkspace.global.get()).toEqual({ initialized: true, workspaceIds: [workspaceId], archivedSessionIds: [] })
  const document = z.object({ version: z.literal(projectionCacheDomainSpec.version), record: checkpointRecord }).parse(JSON.parse(await readFile(recordPath(damaged.id), 'utf8')))
  expect(document.record.rows['recovery/turns']).toEqual({ ver: 1, seq: 1, val: 1 })
})

it.each([
  { name: 'malformed', content: '{unfinished' },
  { name: 'stale-format', content: JSON.stringify({ version: projectionCacheDomainSpec.version + 1, record: { identity: { createdAt: 19 }, rows: {} } }) },
  { name: 'invalid-row', content: JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity: { createdAt: 19 }, rows: { 'recovery/turns': { ver: 1, seq: -5, val: 40 } } } }) },
])('rebuilds a $name checkpoint from the saved log and serves it after restart', async ({ name, content }) => {
  const { load, recordPath } = await environment()
  const initial = await load()
  const meta = { version: 0, id: SessionId(name), createdAt: 19, delegationDepth: 0 }
  await initial.sessionPersistence.create(meta)
  await initial.sessionPersistence.append(meta.id, events)
  const location = initial.sessionPersistence.locate(meta)
  if (!location) throw new Error('JSONL session location missing')
  const bytes = await readFile(location.path, 'utf8')
  await initial.fiber.dispose()
  await mkdir(join(recordPath(meta.id), '..'), { recursive: true })
  await writeFile(recordPath(meta.id), content)

  const recovered = await load()
  expect(recovered.sessionProjectionCache.cachedSnapshot(meta)).toBeUndefined()
  const stored = await recovered.sessionPersistence.load(meta.id)
  expect(recovered.sessionProjectionCache.coldSnapshot(stored.meta, stored.events)).toEqual({ asOfSeq: 1, values: { 'recovery/turns': 1 } })
  await recovered.fiber.dispose()
  const restarted = await load()
  expect(restarted.sessionProjectionCache.cachedSnapshot(meta)).toEqual({ asOfSeq: 1, values: { 'recovery/turns': 1 } })
  expect(await readFile(location.path, 'utf8')).toBe(bytes)
})

it('rebuilds an unreadable checkpoint without deleting it manually and persists the result across restart', async () => {
  const { root, load, recordPath } = await environment()
  const initial = await load()
  const meta = { version: 0, id: SessionId('unreadable'), createdAt: 29, delegationDepth: 0 }
  await initial.sessionPersistence.create(meta)
  await initial.sessionPersistence.append(meta.id, events)
  initial.sessionProjectionCache.coldSnapshot(meta, events)
  await initial.fiber.dispose()
  const path = recordPath(meta.id)
  await writeFile(path, JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity: { createdAt: 29 }, rows: { 'recovery/turns': { ver: 1, seq: 1, val: 40 } } } }))
  await preparePermissionChild(root)
  await denyRecordOperation(path, 'read')
  try {
    runPermissionChild(root, 'read', meta.id)
  } finally {
    await restoreRecordOperation(path, 'read')
  }
  const document = z.object({ record: checkpointRecord }).parse(JSON.parse(await readFile(path, 'utf8')))
  expect(document.record.rows['recovery/turns']).toEqual({ ver: 1, seq: 1, val: 1 })
  const restarted = await load()
  expect(restarted.sessionProjectionCache.cachedSnapshot(meta)).toEqual({ asOfSeq: 1, values: { 'recovery/turns': 1 } })
  expect(await restarted.sessionPersistence.load(meta.id)).toEqual({ meta, events })
})

it('propagates a denied recovery deletion without publishing the domain and retries when access is restored', async () => {
  const { root, load, recordPath, logs } = await environment()
  const initial = await load()
  await initial.fiber.dispose()
  const path = recordPath('denied-delete')
  const directory = join(path, '..')
  await mkdir(directory, { recursive: true })
  const bytes = JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity: { createdAt: 'invalid' }, rows: {} } })
  await writeFile(path, bytes)
  await preparePermissionChild(root)
  await denyRecordOperation(directory, 'delete')
  try {
    runPermissionChild(root, 'delete', 'denied-delete')
    expect(await readFile(path, 'utf8')).toBe(bytes)
  } finally {
    await restoreRecordOperation(directory, 'delete')
  }
  const recovered = await load()
  expect(recovered.storageDomain.get(projectionCacheDomainSpec.name)).toBeDefined()
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: projectionCacheDomainSpec.version, deleted: true })
  expect(logs.some(line => line.includes("removed schema-invalid rebuildable record 'denied-delete'"))).toBe(true)
})

it('keeps corrupt authoritative session history intact and refuses to rebuild from it', async () => {
  const { load } = await environment()
  const initial = await load()
  const meta = { version: 0, id: SessionId('corrupt-history'), createdAt: 23, delegationDepth: 0 }
  await initial.sessionPersistence.create(meta)
  await initial.sessionPersistence.append(meta.id, events)
  const location = initial.sessionPersistence.locate(meta)
  if (!location) throw new Error('JSONL session location missing')
  await initial.fiber.dispose()
  const corrupt = 'invalid session header\n'
  await writeFile(location.path, corrupt)
  const restarted = await load()
  await expect(restarted.sessionPersistence.load(meta.id)).rejects.toThrow(/corrupt session log/)
  expect(restarted.sessionProjectionCache.cachedSnapshot(meta)).toBeUndefined()
  expect(await readFile(location.path, 'utf8')).toBe(corrupt)
})
