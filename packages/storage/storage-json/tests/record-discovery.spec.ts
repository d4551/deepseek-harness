import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'

const roots: string[] = []
const backends: JsonStorageBackend[] = []
const descriptor: KvUnitDescriptor = {
  name: 'records', version: 2, layout: 'per-record', tables: ['items'], hasGlobal: true,
}

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function createTree() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-record-discovery-'))
  roots.push(root)
  await mkdir(join(root, 'records', 'items'), { recursive: true })
  const source = JSON.stringify({ unit: { name: descriptor.name }, tables: { items: { imported: 'source' } } })
  await writeFile(join(root, 'records.json'), source)
  const backend = new JsonStorageBackend(root)
  backends.push(backend)
  return { root, source, backend }
}

describe('record discovery', () => {
  it('keeps current documents authoritative when unrelated root entries exist', async () => {
    const { root, source, backend } = await createTree()
    await writeFile(join(root, 'records', 'items', 'saved.json'), JSON.stringify({ version: 2, record: 'current' }))
    await writeFile(join(root, 'records', 'notes.txt'), 'retained metadata')
    await mkdir(join(root, 'records', 'undeclared'))
    await writeFile(join(root, 'records', 'undeclared', 'other.json'), JSON.stringify({ version: 2, record: 'unowned' }))
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { items: { saved: 'current' } }, global: null })
    expect(await readdir(join(root, 'records', 'items'))).toEqual(['saved.json'])
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(source)
  })

  it('loads only record documents while allowing import beside non-document entries', async () => {
    const { root, backend } = await createTree()
    await writeFile(join(root, 'records', 'items', 'notes.txt'), JSON.stringify({ version: 2, record: 'not a record' }))
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { items: { imported: 'source' } }, global: null })
    expect((await readdir(join(root, 'records', 'items'))).sort()).toEqual(['imported.json', 'notes.txt'])
  })

  it('does not treat an unrelated unit-root file as a global document', async () => {
    const { root, backend } = await createTree()
    const bytes = JSON.stringify({ version: 2, record: 'unrelated root data' })
    await writeFile(join(root, 'records', 'notes.txt'), bytes)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toStrictEqual({ tables: { items: { imported: 'source' } }, global: null })
    expect(await readFile(join(root, 'records', 'notes.txt'), 'utf8')).toBe(bytes)
  })

  it('does not publish keys for invalid record documents', async () => {
    const { root, backend } = await createTree()
    await writeFile(join(root, 'records', 'items', 'broken.json'), '{')
    await writeFile(join(root, 'records', 'items', 'stale.json'), JSON.stringify({ version: 1, record: 'stale' }))
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toStrictEqual({ tables: { items: {} }, global: null })
  })

  it('does not read an undeclared global slot or use it to prevent table import', async () => {
    const { root, backend } = await createTree()
    const global = JSON.stringify({ version: 2, record: 'undeclared global' })
    await writeFile(join(root, 'records', 'global.json'), global)
    const unit = await backend.kv.open({ ...descriptor, hasGlobal: false })
    expect(await unit.loadAll()).toEqual({ tables: { items: { imported: 'source' } }, global: null })
    expect(await readFile(join(root, 'records', 'global.json'), 'utf8')).toBe(global)
  })

  it('does not resurrect source records when the only current document is an invalid global record', async () => {
    const { root, backend } = await createTree()
    await writeFile(join(root, 'records', 'global.json'), '{')
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { items: {} }, global: null })
    expect(await readdir(join(root, 'records', 'items'))).toEqual([])
  })

  it('leaves a regular file at a declared table path unread', async () => {
    const { root, backend } = await createTree()
    await rm(join(root, 'records.json'))
    await rm(join(root, 'records', 'items'), { recursive: true })
    await writeFile(join(root, 'records', 'items'), 'unrelated bytes')
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toEqual({ tables: { items: {} }, global: null })
    expect(await readFile(join(root, 'records', 'items'), 'utf8')).toBe('unrelated bytes')
  })

  it.each([
    null, false, 0, '', { unit: null },
    { unit: null, tables: { items: { unowned: true } } },
    { unit: 0, tables: { items: { unowned: true } } },
    { unit: false, tables: { items: { unowned: true } } },
    { unit: 'records', tables: { items: { unowned: true } } },
    { unit: {}, tables: { items: { unowned: true } } },
    { unit: { name: 'another' }, tables: { items: { unowned: true } } },
    { unit: { name: 'records' }, tables: null },
  ])
  ('leaves a non-unit source %j unchanged', async (document) => {
    const { root, backend } = await createTree()
    const source = JSON.stringify(document)
    await writeFile(join(root, 'records.json'), source)
    const unit = await backend.kv.open(descriptor)
    expect(await unit.loadAll()).toStrictEqual({ tables: { items: {} }, global: null })
    expect(await readdir(join(root, 'records', 'items'))).toEqual([])
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(source)
  })
})
