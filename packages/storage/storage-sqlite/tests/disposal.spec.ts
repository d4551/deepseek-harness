import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { expect, it, onTestFinished } from 'vitest'
import * as StorageSqlite from '../src/index.ts'

it('keeps the file database open until a retiring consumer drains both queued writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-disposal-'))
  const path = join(root, 'storage.db')
  const ctx = new Context()
  const readers: StorageSqlite.SqliteStorageBackend[] = []
  const descriptor = { name: 'retirement', version: 1, tables: ['records'], hasGlobal: false }
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    for (const reader of readers) await reader.close()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path })
  await ctx.plugin({
    name: 'sqlite-durable-consumer',
    inject: ['storage', storageBackendServiceKey('sqlite')],
    async apply(inner) {
      const backend = inner.storage.backend.get('sqlite')
      if (!backend.kv) throw new Error('SQLite backend has no KV facet')
      const unit = await backend.kv.open(descriptor)
      return async () => {
        const first = Promise.resolve().then(() => unit.putRecord('records', 'first', { order: 1 }))
        const second = first.then(() => unit.putRecord('records', 'second', { order: 2 }))
        await second
        await unit.close()
      }
    },
  })
  await ctx.fiber.dispose()
  expect((await stat(path)).size).toBeGreaterThan(0)
  const reopened = new StorageSqlite.SqliteStorageBackend(new StorageSqlite.Config({ path }))
  readers.push(reopened)
  const unit = await reopened.kv.open(descriptor)
  expect(await unit.loadAll()).toEqual({
    tables: { records: { first: { order: 1 }, second: { order: 2 } } },
    global: null,
  })
  await reopened.close()
})
