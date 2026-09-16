import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'

const roots: string[] = []
const backends: JsonStorageBackend[] = []
const descriptor: KvUnitDescriptor = { name: 'records', version: 1, tables: ['items'], hasGlobal: false }

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function createBackend() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-json-lifecycle-'))
  roots.push(directory)
  const root = join(directory, 'data')
  const backend = new JsonStorageBackend(root)
  backends.push(backend)
  return { directory, root, backend }
}

describe('JSON backend ownership', () => {
  it('rejects opens after shutdown before creating the configured directory', async () => {
    const { directory, backend } = await createBackend()
    await backend.close()
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({
      code: 'closed', message: 'json backend is closed',
    })
    expect(await readdir(directory)).toEqual([])
  })

  it('reserves a unit while its first open is still pending', async () => {
    const { backend } = await createBackend()
    const first = backend.kv.open(descriptor)
    await expect(backend.kv.open(descriptor)).rejects.toThrow(
      "unit 'records' is already open; a unit has exactly one live handle",
    )
    const unit = await first
    await unit.close()
    expect(await (await backend.kv.open(descriptor)).loadAll()).toEqual({ tables: { items: {} }, global: null })
  })

  it.each(['single', 'per-record'] satisfies KvUnitDescriptor['layout'][])
  ('rejects the %s open itself when shutdown begins before it completes', async (layout) => {
    const { backend } = await createBackend()
    const opening = Promise.allSettled([backend.kv.open({ ...descriptor, layout })])
    await backend.close()
    expect(await opening).toMatchObject([{ status: 'rejected', reason: {
      code: 'closed', message: 'json backend is closed',
    } }])
  })

  it.each(['single', 'per-record'] satisfies KvUnitDescriptor['layout'][])
  ('settles pending %s opens before backend shutdown resolves', async (layout) => {
    const { backend } = await createBackend()
    const settled: string[] = []
    const opening = Promise.allSettled([backend.kv.open({ ...descriptor, layout }).finally(() => {
      settled.push('open')
    })])
    await backend.close()
    settled.push('close')
    expect(settled).toEqual(['open', 'close'])
    expect(await opening).toMatchObject([{ status: 'rejected', reason: { code: 'closed' } }])
  })

  it('releases a failed open reservation so corrected storage can open', async () => {
    const { root, backend } = await createBackend()
    const initial = await backend.kv.open(descriptor)
    await initial.close()
    await writeFile(join(root, 'records.json'), '{')
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'malformed-medium' })
    await rm(join(root, 'records.json'))
    expect(await (await backend.kv.open(descriptor)).loadAll()).toEqual({ tables: { items: {} }, global: null })
  })

  it('does not release a newer handle when a previously closed handle closes again', async () => {
    const { backend } = await createBackend()
    const original = await backend.kv.open(descriptor)
    await original.close()
    const current = await backend.kv.open(descriptor)
    await original.close()
    await expect(backend.kv.open(descriptor)).rejects.toThrow(/already open/)
    await expect(original.loadAll()).rejects.toMatchObject({
      code: 'closed', message: "unit 'records' is closed",
    })
    await current.putRecord('items', 'current', true)
    expect(await current.loadAll()).toEqual({ tables: { items: { current: true } }, global: null })
  })

  it.each(['single', 'per-record'] satisfies KvUnitDescriptor['layout'][])
  ('makes the %s write durable before close resolves', async (layout) => {
    const { root, backend } = await createBackend()
    const unit = await backend.kv.open({ ...descriptor, layout })
    const payload = 'durable'.repeat(16_384)
    const writing = Promise.allSettled([unit.putRecord('items', 'saved', payload)])
    await unit.close()
    const path = layout === 'single' ? join(root, 'records.json') : join(root, 'records', 'items', 'saved.json')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(layout === 'single'
      ? { unit: { name: 'records', version: 1 }, tables: { items: { saved: payload } }, global: null }
      : { version: 1, record: payload })
    expect(await writing).toEqual([{ status: 'fulfilled', value: undefined }])
  })

  it('identifies invalid unit and table names before accessing storage', async () => {
    const { directory, backend } = await createBackend()
    await expect(backend.kv.open({ ...descriptor, name: '../outside' })).rejects.toMatchObject({
      code: 'malformed-medium', message: "invalid unit name '../outside'",
    })
    await expect(backend.kv.open({ ...descriptor, tables: ['../outside'] })).rejects.toMatchObject({
      code: 'malformed-medium', message: "invalid table name '../outside' in unit 'records'",
    })
    expect(await readdir(directory)).toEqual([])
  })
})
