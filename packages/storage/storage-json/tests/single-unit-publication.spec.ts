import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'

const roots: string[] = []
const backends: JsonStorageBackend[] = []
const descriptor = { name: 'records', version: 1, tables: ['items'], hasGlobal: true }
const committed = { tables: { items: { saved: 'committed' } }, global: 'committed' }
const changes = [
  {
    name: 'insert',
    write: (unit: KvUnit) => unit.putRecord('items', 'added', 'published'),
    snapshot: { tables: { items: { saved: 'committed', added: 'published' } }, global: 'committed' },
  },
  {
    name: 'overwrite',
    write: (unit: KvUnit) => unit.putRecord('items', 'saved', 'published'),
    snapshot: { tables: { items: { saved: 'published' } }, global: 'committed' },
  },
  {
    name: 'delete',
    write: (unit: KvUnit) => unit.deleteRecord('items', 'saved'),
    snapshot: { tables: { items: {} }, global: 'committed' },
  },
  {
    name: 'global',
    write: (unit: KvUnit) => unit.setGlobal('published'),
    snapshot: { tables: { items: { saved: 'committed' } }, global: 'published' },
  },
]

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function openCommittedUnit() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-single-publication-'))
  roots.push(root)
  const backend = new JsonStorageBackend(root)
  backends.push(backend)
  const unit = await backend.kv.open(descriptor)
  await unit.putRecord('items', 'saved', 'committed')
  await unit.setGlobal('committed')
  return { root, backend, unit, path: join(root, 'records.json') }
}

describe('single-unit publication', () => {
  it.each(changes)('keeps pending $name invisible until durable publication', async ({ write, snapshot }) => {
    const { unit, backend, path } = await openCommittedUnit()
    const writing = Promise.allSettled([write(unit)])
    // The read captures memory before asynchronous file publication can complete.
    expect(await unit.loadAll()).toEqual(committed)
    expect(await writing).toEqual([{ status: 'fulfilled', value: undefined }])
    expect(await unit.loadAll()).toEqual(snapshot)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      unit: { name: 'records', version: 1 }, ...snapshot,
    })
    await unit.close()
    expect(await (await backend.kv.open(descriptor)).loadAll()).toEqual(snapshot)
  })

  it.each(changes)('never exposes a rejected $name', async ({ write }) => {
    const { unit, path } = await openCommittedUnit()
    const backup = `${path}.committed`
    await rename(path, backup)
    await mkdir(path)
    const writing = Promise.allSettled([write(unit)])
    expect(await unit.loadAll()).toEqual(committed)
    expect(await writing).toMatchObject([{ status: 'rejected', reason: { name: 'Error' } }])
    expect(await unit.loadAll()).toEqual(committed)
    await rm(path, { recursive: true })
    await rename(backup, path)
    await unit.putRecord('items', 'later', 'published later')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      unit: { name: 'records', version: 1 },
      tables: { items: { saved: 'committed', later: 'published later' } },
      global: 'committed',
    })
  })

  it('captures an open snapshot before close and rejects reads begun after close', async () => {
    const { unit } = await openCommittedUnit()
    const reading = unit.loadAll()
    const closing = unit.close()
    expect(await reading).toEqual(committed)
    const rejected = unit.loadAll()
    await expect(rejected).rejects.toMatchObject({ code: 'closed' })
    await closing
  })

  it('drains publication before releasing the unit to another opener', async () => {
    const { unit, backend } = await openCommittedUnit()
    const writing = Promise.allSettled([unit.putRecord('items', 'added', 'published')])
    await unit.close()
    expect(await writing).toEqual([{ status: 'fulfilled', value: undefined }])
    const reopened = await backend.kv.open(descriptor)
    expect(await reopened.loadAll()).toEqual({
      tables: { items: { saved: 'committed', added: 'published' } }, global: 'committed',
    })
  })
})
