import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'
import { INITIALIZATION_FILE } from '../src/initialization.ts'

const roots: string[] = []
const backends: JsonStorageBackend[] = []
const descriptor: KvUnitDescriptor = {
  name: 'records', version: 2, layout: 'per-record', tables: ['first', 'second'], hasGlobal: false,
}

afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function openDocument(second: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-bootstrap-'))
  roots.push(root)
  const document = JSON.stringify({
    unit: { name: descriptor.name, version: 1 },
    tables: { first: { valid: { saved: true } }, second },
  })
  await writeFile(join(root, 'records.json'), document)
  await writeFile(join(root, 'victim.json'), 'unrelated durable data')
  const backend = new JsonStorageBackend(root)
  backends.push(backend)
  const unit = await backend.kv.open(descriptor)
  return { root, document, unit }
}

describe('whole-unit import boundary', () => {
  it.each(['../../victim', '..\\..\\victim', 'nested/key', '', '.'])
  ('rejects key %j before publishing any record', async (key) => {
    const { root, document, unit } = await openDocument({ [key]: { overwritten: true } })
    await expect(unit.loadAll()).rejects.toThrow(/not path-safe/)
    expect((await readdir(root)).sort()).toEqual(['records.json', 'victim.json'])
    expect(await readFile(join(root, 'victim.json'), 'utf8')).toBe('unrelated durable data')
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(document)
    await expect(unit.loadAll()).rejects.toThrow(/not path-safe/)
  })

  it.each([null, ['invalid'], 'invalid', 17])
  ('rejects a non-object table %j before publishing earlier tables', async (table) => {
    const { root, document, unit } = await openDocument(table)
    await expect(unit.loadAll()).rejects.toMatchObject({
      code: 'malformed-medium',
      message: "unit 'records': table 'second' is not an object",
    })
    expect((await readdir(root)).sort()).toEqual(['records.json', 'victim.json'])
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(document)
  })

  it('imports safe keys from every declared table and preserves source bytes', async () => {
    const { root, document, unit } = await openDocument({ 'safe-key_2': { saved: true } })
    const expected = {
      global: null,
      tables: { first: { valid: { saved: true } }, second: { 'safe-key_2': { saved: true } } },
    }
    expect(await unit.loadAll()).toEqual(expected)
    expect((await readdir(join(root, 'records'))).sort()).toEqual([INITIALIZATION_FILE, 'first', 'second'])
    expect(JSON.parse(await readFile(join(root, 'records', INITIALIZATION_FILE), 'utf8')))
      .toEqual({ format: 1, name: descriptor.name, status: 'ready' })
    expect(await readdir(join(root, 'records', 'first'))).toEqual(['valid.json'])
    expect(await readdir(join(root, 'records', 'second'))).toEqual(['safe-key_2.json'])
    for (const path of ['first/valid.json', 'second/safe-key_2.json']) {
      expect(JSON.parse(await readFile(join(root, 'records', path), 'utf8'))).toEqual({
        version: 2, record: { saved: true },
      })
    }
    expect(await readFile(join(root, 'records.json'), 'utf8')).toBe(document)
    expect(await readFile(join(root, 'victim.json'), 'utf8')).toBe('unrelated durable data')
    await unit.close()
    await rm(join(root, 'records.json'))
    const reopened = new JsonStorageBackend(root)
    backends.push(reopened)
    expect(await (await reopened.kv.open(descriptor)).loadAll()).toEqual(expected)
    expect((await readdir(root)).sort()).toEqual(['records', 'victim.json'])
  })

  it('reads corrected input after rejection without retaining records from the rejected document', async () => {
    const { root, unit } = await openDocument({ '../outside': { saved: false } })
    await expect(unit.loadAll()).rejects.toThrow(/not path-safe/)
    await writeFile(join(root, 'records.json'), JSON.stringify({
      unit: { name: descriptor.name, version: 1 },
      tables: { second: { recovered: { saved: true } } },
    }))
    const expected = {
      global: null,
      tables: { first: {}, second: { recovered: { saved: true } } },
    }
    expect(await unit.loadAll()).toEqual(expected)
    expect(await readdir(join(root, 'records'))).toEqual([INITIALIZATION_FILE, 'second'])
    expect(JSON.parse(await readFile(join(root, 'records', INITIALIZATION_FILE), 'utf8')))
      .toEqual({ format: 1, name: descriptor.name, status: 'ready' })
    expect(JSON.parse(await readFile(join(root, 'records', 'second', 'recovered.json'), 'utf8'))).toEqual({
      version: 2, record: { saved: true },
    })
    await unit.close()
    await rm(join(root, 'records.json'))
    const reopened = new JsonStorageBackend(root)
    backends.push(reopened)
    expect(await (await reopened.kv.open(descriptor)).loadAll()).toEqual(expected)
  })
})
