import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'
import { INITIALIZATION_FILE } from '../src/initialization.ts'

const descriptor: KvUnitDescriptor = {
  name: 'records', version: 2, layout: 'per-record', tables: ['first', 'second'], hasGlobal: true,
}

async function storage() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-json-initialization-'))
  const backend = new JsonStorageBackend(root)
  onTestFinished(async () => {
    await backend.close()
    await rm(root, { recursive: true, force: true })
  })
  const source = JSON.stringify({
    unit: { name: descriptor.name, version: 1 },
    global: 'not imported',
    tables: { first: { saved: { value: 1 } }, second: { neighbor: false } },
  })
  await writeFile(join(root, 'records.json'), source)
  const unit = await backend.kv.open(descriptor)
  return { root, backend, unit, source }
}

const imported = { tables: { first: { saved: { value: 1 } }, second: { neighbor: false } }, global: null }

describe('persistent per-record initialization', () => {
  it('keeps deletion of every imported record authoritative across reads and reopen', async () => {
    const { root, backend, unit, source } = await storage()
    expect(await unit.loadAll()).toEqual(imported)
    await unit.deleteRecord('first', 'saved')
    await unit.deleteRecord('second', 'neighbor')
    const empty = { tables: { first: {}, second: {} }, global: null }
    expect(await unit.loadAll()).toEqual(empty)
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(source)
    expect(JSON.parse(await readFile(join(root, 'records', 'first', 'saved.json'), 'utf8')))
      .toEqual({ version: 2, deleted: true })
    await unit.close()
    const reopened = await backend.kv.open(descriptor)
    expect(await reopened.loadAll()).toEqual(empty)
    await reopened.putRecord('first', 'saved', { deleted: true, record: null })
    expect(await reopened.loadAll()).toEqual({
      tables: { first: { saved: { deleted: true, record: null } }, second: {} }, global: null,
    })
  })

  it('finishes the captured snapshot after a real interrupted import and source replacement', async () => {
    const { root, backend, unit } = await storage()
    await mkdir(join(root, 'records'))
    const obstruction = join(root, 'records', 'second')
    await writeFile(obstruction, 'a file obstructs the second table')
    await expect(unit.loadAll()).rejects.toThrow()
    expect(JSON.parse(await readFile(join(root, 'records', 'first', 'saved.json'), 'utf8')))
      .toEqual({ version: 2, record: { value: 1 } })
    const pending = await readFile(join(root, 'records', INITIALIZATION_FILE), 'utf8')
    expect(JSON.parse(pending)).toMatchObject({ status: 'importing' })
    await writeFile(join(root, 'records.json'), 'the source is no longer available')
    await rm(obstruction)
    await unit.close()
    const reopened = await backend.kv.open(descriptor)
    expect(await reopened.loadAll()).toEqual(imported)
    expect(JSON.parse(await readFile(join(root, 'records', INITIALIZATION_FILE), 'utf8')))
      .toEqual({ format: 1, name: descriptor.name, status: 'ready' })
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe('the source is no longer available')
  })

  it('retries a failed import on the same handle after its obstruction is removed', async () => {
    const { root, unit } = await storage()
    await mkdir(join(root, 'records'))
    const obstruction = join(root, 'records', 'second')
    await writeFile(obstruction, 'obstruction')
    await expect(unit.loadAll()).rejects.toThrow()
    await rm(obstruction)
    expect(await unit.loadAll()).toEqual(imported)
  })

  it.each(['put', 'delete', 'global'])('initializes before a direct %s without a preceding read', async (operation) => {
    const { unit, root, source } = await storage()
    if (operation === 'put') await unit.putRecord('first', 'saved', 'changed')
    if (operation === 'delete') await unit.deleteRecord('first', 'saved')
    if (operation === 'global') await unit.setGlobal('selected')
    expect(await unit.loadAll()).toEqual({
      tables: {
        first: operation === 'delete' ? {} : { saved: operation === 'put' ? 'changed' : { value: 1 } },
        second: { neighbor: false },
      },
      global: operation === 'global' ? 'selected' : null,
    })
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(source)
  })

  it('drains shared initialization before releasing the unit during close', async () => {
    const { backend, unit, root } = await storage()
    const reads = Promise.all([unit.loadAll(), unit.loadAll()])
    await unit.close()
    expect(JSON.parse(await readFile(join(root, 'records', INITIALIZATION_FILE), 'utf8')))
      .toEqual({ format: 1, name: descriptor.name, status: 'ready' })
    expect(await reads).toEqual([imported, imported])
    const reopened = await backend.kv.open(descriptor)
    expect(await reopened.loadAll()).toEqual(imported)
  })

  it('does not restamp an interrupted snapshot after the descriptor version changes', async () => {
    const { root, backend, unit } = await storage()
    await mkdir(join(root, 'records'))
    const obstruction = join(root, 'records', 'second')
    await writeFile(obstruction, 'obstruction')
    await expect(unit.loadAll()).rejects.toThrow()
    await rm(obstruction)
    await unit.close()
    const reopened = await backend.kv.open({ ...descriptor, version: 3 })
    expect(await reopened.loadAll()).toEqual({ tables: { first: {}, second: {} }, global: null })
    expect(JSON.parse(await readFile(join(root, 'records', 'second', 'neighbor.json'), 'utf8')))
      .toEqual({ version: 2, record: false })
  })

  it('records an empty import and prevents a later source from adding records', async () => {
    const { unit, root, backend } = await storage()
    await writeFile(join(root, 'records.json'), JSON.stringify({ unit: { name: descriptor.name }, tables: {} }))
    expect(await unit.loadAll()).toEqual({ tables: { first: {}, second: {} }, global: null })
    await unit.close()
    await writeFile(join(root, 'records.json'), JSON.stringify({ unit: { name: descriptor.name }, tables: { first: { late: true } } }))
    const reopened = await backend.kv.open(descriptor)
    expect(await reopened.loadAll()).toEqual({ tables: { first: {}, second: {} }, global: null })
    expect(await readdir(join(root, 'records'))).toEqual([INITIALIZATION_FILE])
  })

  it.each(['missing', 'malformed', 'foreign'])('allows a corrected %s source after an empty read', async (kind) => {
    const { unit, root, source } = await storage()
    const path = join(root, 'records.json')
    if (kind === 'missing') await rm(path)
    if (kind === 'malformed') await writeFile(path, '{')
    if (kind === 'foreign') await writeFile(path, JSON.stringify({ unit: { name: 'other' }, tables: {} }))
    expect(await unit.loadAll()).toEqual({ tables: { first: {}, second: {} }, global: null })
    expect(await readdir(root)).toEqual(kind === 'missing' ? [] : ['records.json'])
    await writeFile(path, source)
    expect(await unit.loadAll()).toEqual(imported)
  })

  it('makes a direct missing-key deletion authoritative before a source appears', async () => {
    const { unit, root, source, backend } = await storage()
    await rm(join(root, 'records.json'))
    await unit.deleteRecord('first', 'saved')
    await writeFile(join(root, 'records.json'), source)
    expect(await unit.loadAll()).toEqual({ tables: { first: {}, second: {} }, global: null })
    await unit.close()
    expect(await (await backend.kv.open(descriptor)).loadAll()).toEqual({ tables: { first: {}, second: {} }, global: null })
    expect(await readdir(join(root, 'records'))).toEqual([INITIALIZATION_FILE])
  })

  it('materializes a mutation that joins an empty read', async () => {
    const { unit, root, source, backend } = await storage()
    await rm(join(root, 'records.json'))
    const reading = unit.loadAll()
    await unit.putRecord('first', 'current', true)
    await reading
    await writeFile(join(root, 'records.json'), source)
    await unit.close()
    expect(await (await backend.kv.open(descriptor)).loadAll()).toEqual({
      tables: { first: { current: true }, second: {} }, global: null,
    })
  })

  it.each(['{', JSON.stringify({ format: 2, name: descriptor.name, status: 'ready' }),
    JSON.stringify({ format: 1, name: 'foreign', status: 'ready' }),
    JSON.stringify({ format: 1, name: descriptor.name, status: 'unexpected' }),
    JSON.stringify({ format: 1, name: descriptor.name, status: 'ready', snapshot: 'uncommitted' }),
    JSON.stringify({ format: 1, name: descriptor.name, status: 'importing', snapshot: '{}', extra: true })])
  ('rejects invalid initialization metadata %j without importing', async (metadata) => {
    const { root, unit, source } = await storage()
    await mkdir(join(root, 'records'))
    await writeFile(join(root, 'records', INITIALIZATION_FILE), metadata)
    await expect(unit.loadAll()).rejects.toThrow()
    expect(await readdir(join(root, 'records'))).toEqual([INITIALIZATION_FILE])
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(source)
  })

  it.each([
    'null', '{',
    JSON.stringify({ unit: { name: descriptor.name, version: -1 }, tables: {} }),
    JSON.stringify({ unit: { name: descriptor.name, version: 2 }, tables: { '../outside': {} } }),
    JSON.stringify({ unit: { name: descriptor.name, version: 2 }, tables: { first: { '../outside': true } } }),
    JSON.stringify({ unit: { name: 'foreign', version: 2 }, tables: {} }),
  ])('rejects unsafe or malformed captured snapshots before recovery writes: %j', async (snapshot) => {
    const { root, unit, source } = await storage()
    await mkdir(join(root, 'records'))
    const metadata = JSON.stringify({ format: 1, name: descriptor.name, status: 'importing', snapshot })
    await writeFile(join(root, 'records', INITIALIZATION_FILE), metadata)
    await writeFile(join(root, 'outside.json'), 'unrelated durable data')
    await expect(unit.loadAll()).rejects.toThrow()
    expect(await readdir(join(root, 'records'))).toEqual([INITIALIZATION_FILE])
    expect(await readFile(join(root, 'records', INITIALIZATION_FILE), 'utf8')).toBe(metadata)
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(source)
    expect(await readFile(join(root, 'outside.json'), 'utf8')).toBe('unrelated durable data')
  })
})
