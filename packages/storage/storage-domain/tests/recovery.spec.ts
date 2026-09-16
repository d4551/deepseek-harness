import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Logger } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { defineDomain, descriptorOf, DomainFacility, domainTable } from '../src/index.ts'

const row = z.object({ count: z.number().int().nonnegative() })
const spec = defineDomain({
  name: 'recovery', version: 1, layout: 'per-record',
  global: { schema: z.object({ owner: z.string() }), initial: { owner: 'session-log' } },
  tables: {
    derived: domainTable(row, { rebuildable: true }),
    authority: domainTable(row),
  },
})

async function environment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-domain-recovery-'))
  const ctx = new Context()
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export(message) { logs.push(Logger.format(this, message)) } })
  await ctx.plugin(Storage)
  const backend = new JsonStorageBackend(root)
  ctx.storage.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  onTestFinished(async () => {
    await facility.closeAll()
    await backend.close()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const unit = await backend.kv.open(descriptorOf(spec))
  await unit.putRecord('derived', 'valid', { count: 7 })
  await unit.putRecord('derived', 'invalid', { count: 'broken' })
  await unit.putRecord('authority', 'saved', { count: 13 })
  await unit.setGlobal({ owner: 'session-log' })
  await unit.close()
  return { root, backend, facility, logs }
}

it('removes each rejected derived record durably while preserving valid neighbors and authoritative state', async () => {
  const { root, facility, logs } = await environment()
  const authorityPath = join(root, spec.name, 'authority', 'saved.json')
  const authorityBytes = await readFile(authorityPath, 'utf8')
  const globalPath = join(root, spec.name, 'global.json')
  const globalBytes = await readFile(globalPath, 'utf8')
  const domain = await facility.open(spec)
  expect([...domain.table('derived').entries()]).toEqual([['valid', { count: 7 }]])
  expect(domain.table('authority').get('saved')).toEqual({ count: 13 })
  expect(domain.global.get()).toEqual({ owner: 'session-log' })
  expect(JSON.parse(await readFile(join(root, spec.name, 'derived', 'invalid.json'), 'utf8')))
    .toEqual({ version: spec.version, deleted: true })
  expect(await readFile(authorityPath, 'utf8')).toBe(authorityBytes)
  expect(await readFile(globalPath, 'utf8')).toBe(globalBytes)
  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain("removed schema-invalid rebuildable record 'invalid' in table 'derived'")
  await domain.close()
  const reopened = await facility.open(spec)
  expect([...reopened.table('derived').entries()]).toEqual([['valid', { count: 7 }]])
  expect(logs).toHaveLength(1)
})

it('rejects invalid authoritative records and keeps their stored bytes across repeated opens', async () => {
  const { root, backend, facility } = await environment()
  const unit = await backend.kv.open(descriptorOf(spec))
  await unit.putRecord('authority', 'broken', { count: 'broken' })
  await unit.close()
  const path = join(root, spec.name, 'authority', 'broken.json')
  const bytes = await readFile(path, 'utf8')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(facility.open(spec)).rejects.toMatchObject({ code: 'invalid-record', detail: { table: 'authority', key: 'broken' } })
    expect(facility.get(spec.name)).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }
})

it('rejects an invalid global even when a table permits derived-record recovery', async () => {
  const { root, backend, facility } = await environment()
  const unit = await backend.kv.open(descriptorOf(spec))
  await unit.setGlobal({ owner: 42 })
  await unit.close()
  const path = join(root, spec.name, 'global.json')
  const bytes = await readFile(path, 'utf8')
  await expect(facility.open(spec)).rejects.toMatchObject({ code: 'invalid-record', detail: { table: '', key: '' } })
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it('propagates unit read failures without deleting records or publishing a domain', async () => {
  const { root, facility, logs } = await environment()
  const directory = join(root, spec.name)
  const path = join(directory, 'derived', 'invalid.json')
  const bytes = await readFile(path, 'utf8')
  const displaced = join(root, 'retained-records')
  await rename(directory, displaced)
  await writeFile(directory, 'not a directory')
  await expect(facility.open(spec)).rejects.toMatchObject({ code: 'ENOTDIR' })
  expect(facility.get(spec.name)).toBeUndefined()
  expect(logs).toEqual([])
  await rm(directory)
  await rename(displaced, directory)
  expect(await readFile(path, 'utf8')).toBe(bytes)
  const domain = await facility.open(spec)
  expect([...domain.table('derived').keys()]).toEqual(['valid'])
})
