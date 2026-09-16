import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as JsonStoragePlugin from '../src/index.ts'

async function composition() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-json-composition-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.storage = Storage
  ctx.loader.builtins['storage-json'] = JsonStoragePlugin
  return { ctx, root, configPath: join(root, 'cordis.yml') }
}

describe('storage-json Loader composition', () => {
  it('releases its registration when lifecycle service publication is rejected', async () => {
    const { ctx, root } = await composition()
    await ctx.plugin(Storage)
    const existing = new JsonStoragePlugin.JsonStorageBackend(join(root, 'existing'))
    onTestFinished(() => existing.close())
    ctx.provide(storageBackendServiceKey('json'), existing)
    await expect(ctx.plugin(JsonStoragePlugin, { root: join(root, 'rejected') }))
      .rejects.toThrow(/service "storage.backend.json" has been registered/)
    expect(ctx.storage.backend.names()).toEqual([])
    expect(ctx.get(storageBackendServiceKey('json'))).toBe(existing)
    expect(await readdir(root)).toEqual([])
  })

  it('waits for the hub, persists under the configured root, and disposes and remounts the backend', async () => {
    const { ctx, root, configPath } = await composition()
    const storageRoot = join(root, 'configured-storage')
    await writeFile(configPath, [
      '- id: json',
      '  name: cordis:storage-json',
      '  config:',
      `    root: ${JSON.stringify(storageRoot)}`,
      '- id: hub',
      '  name: cordis:storage',
      '  disabled: true', '',
    ].join('\n'))
    const includeId = await ctx.loader.create({
      name: 'cordis:include', config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    const jsonId = `${includeId}:json`
    const jsonEntry = ctx.loader.resolve(jsonId)
    expect(jsonEntry.fiber?.runtime?.name).toBe('storage-json')
    expect(jsonEntry.fiber?.runtime?.callback).toBe(JsonStoragePlugin.apply)
    expect(ctx.get(storageBackendServiceKey('json'))).toBeUndefined()
    expect(ctx.get('storage')).toBeUndefined()

    await ctx.loader.update(`${includeId}:hub`, { disabled: false })
    await ctx.loader.await()
    expect(ctx.storage.backend.names()).toEqual(['json'])
    const backend = ctx.storage.backend.get('json')
    expect(ctx.get(storageBackendServiceKey('json'))).toBe(backend)
    if (!backend.kv) throw new Error('composed JSON backend must expose KV storage')
    const descriptor = { name: 'composed', version: 1, tables: ['items'], hasGlobal: true }
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('items', 'saved', { message: 'durable through remount' })
    await unit.setGlobal({ revision: 1 })
    expect(JSON.parse(await readFile(join(storageRoot, 'composed.json'), 'utf8'))).toEqual({
      unit: { name: 'composed', version: 1 },
      tables: { items: { saved: { message: 'durable through remount' } } },
      global: { revision: 1 },
    })

    await ctx.loader.update(jsonId, { disabled: true })
    await ctx.loader.await()
    expect(ctx.storage.backend.names()).toEqual([])
    expect(() => ctx.storage.backend.get('json')).toThrow(/not registered/)
    expect(ctx.get(storageBackendServiceKey('json'))).toBeUndefined()
    await expect(unit.putRecord('items', 'after-disposal', {})).rejects.toMatchObject({ code: 'closed' })
    await expect(backend.kv.open(descriptor)).rejects.toMatchObject({ code: 'closed' })

    await ctx.loader.update(jsonId, { disabled: false })
    await ctx.loader.await()
    const remounted = ctx.storage.backend.get('json')
    expect(remounted).not.toBe(backend)
    expect(ctx.get(storageBackendServiceKey('json'))).toBe(remounted)
    if (!remounted.kv) throw new Error('remounted JSON backend must expose KV storage')
    const restored = await remounted.kv.open(descriptor)
    expect(await restored.loadAll()).toEqual({
      tables: { items: { saved: { message: 'durable through remount' } } },
      global: { revision: 1 },
    })
    await ctx.fiber.dispose()
    await expect(restored.loadAll()).rejects.toMatchObject({ code: 'closed' })
    await expect(remounted.kv.open(descriptor)).rejects.toMatchObject({ code: 'closed' })
  })

  it.each([
    { config: '{}', error: /missing required value/ },
    { config: '{ root: 3 }', error: /expected string/ },
  ])('rejects invalid assembly configuration $config through the exported schema', async ({ config, error }) => {
    const { ctx, configPath } = await composition()
    await writeFile(configPath, [
      '- name: cordis:storage',
      '- name: cordis:storage-json',
      `  config: ${config}`, '',
    ].join('\n'))
    await expect(ctx.loader.create({
      name: 'cordis:include', config: { path: pathToFileURL(configPath).href },
    })).rejects.toThrow(error)
    expect(ctx.get(storageBackendServiceKey('json'))).toBeUndefined()
    expect([...ctx.loader.entries()]).toEqual([])
  })
})
