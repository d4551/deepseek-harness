import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'

async function directories() {
  const previous = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-storage-root-'))
  const origin = join(directory, 'origin')
  const other = join(directory, 'other')
  await mkdir(origin)
  await mkdir(other)
  process.chdir(origin)
  const backend = new JsonStorageBackend('data')
  onTestFinished(async () => {
    process.chdir(previous)
    await backend.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { backend, origin, other }
}

describe.each(['single', 'per-record'] satisfies KvUnitDescriptor['layout'][])('stable %s storage root', (layout) => {
  const descriptor: KvUnitDescriptor = { name: 'workspaces', version: 1, tables: ['items'], hasGlobal: true, layout }

  it('anchors the root at construction before the first unit opens', async () => {
    const { backend, origin, other } = await directories()
    process.chdir(other)
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('items', 'saved', { path: '/project' })
    await unit.setGlobal({ selected: 'saved' })
    await backend.close()

    const reopened = new JsonStorageBackend(join(origin, 'data'))
    onTestFinished(() => reopened.close())
    const durable = await reopened.kv.open(descriptor)
    expect(await durable.loadAll()).toEqual({
      tables: { items: { saved: { path: '/project' } } },
      global: { selected: 'saved' },
    })
    expect(await readdir(other)).toEqual([])
  })

  it('keeps reads, writes, deletes and later unit opens in the original root', async () => {
    const { backend, origin, other } = await directories()
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('items', 'removed', { path: '/removed' })
    await unit.putRecord('items', 'kept', { path: '/kept' })
    process.chdir(other)
    expect(await unit.loadAll()).toEqual({
      tables: { items: { removed: { path: '/removed' }, kept: { path: '/kept' } } },
      global: null,
    })
    await unit.deleteRecord('items', 'removed')
    await unit.putRecord('items', 'added', { path: '/added' })
    await unit.setGlobal({ selected: 'added' })
    await unit.close()
    const later = await backend.kv.open({ ...descriptor, name: 'preferences' })
    await later.setGlobal({ ready: true })
    await backend.close()

    const reopened = new JsonStorageBackend(join(origin, 'data'))
    onTestFinished(() => reopened.close())
    const durable = await reopened.kv.open(descriptor)
    expect(await durable.loadAll()).toEqual({
      tables: { items: { kept: { path: '/kept' }, added: { path: '/added' } } },
      global: { selected: 'added' },
    })
    const laterDurable = await reopened.kv.open({ ...descriptor, name: 'preferences' })
    expect(await laterDurable.loadAll()).toEqual({ tables: { items: {} }, global: { ready: true } })
    expect(await readdir(other)).toEqual([])
  })
})
