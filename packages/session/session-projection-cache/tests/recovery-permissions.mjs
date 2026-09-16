import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Logger } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import { recoveryProjection } from './recovery-projection.ts'

for (const [name, path] of [
  ['@deepseek-ai/cordis', '../../../../vendor/cordis/src/index.ts'],
  ['@deepseek-ai/dsh-storage', '../../../storage/storage/src/index.ts'],
  ['@deepseek-ai/dsh-storage-json', '../../../storage/storage-json/src/index.ts'],
  ['@deepseek-ai/dsh-storage-domain', '../../../storage/storage-domain/src/index.ts'],
  ['@deepseek-ai/dsh-session-projection-cache', '../src/index.ts'],
]) {
  assert.equal(fileURLToPath(import.meta.resolve(name)), fileURLToPath(new URL(path, import.meta.url)))
}

const [mode, root, id] = process.argv.slice(2)
assert.ok(root)
assert.ok(id)
assert.ok(mode === 'delete' || mode === 'read')
const originalUid = process.geteuid?.()
const originalGid = process.getegid?.()
const ctx = new Context()
const logs = []
ctx.logger.exporter({ levels: { default: 3 }, export(message) { logs.push(Logger.format(this, message)) } })
try {
  if (originalUid === 0) {
    process.setegid(65534)
    process.seteuid(65534)
    assert.equal(process.geteuid(), 65534)
  }
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  if (mode === 'delete') {
    const recordPath = join(root, 'storage', projectionCacheDomainSpec.name, 'sessions', `${id}.json`)
    const original = await readFile(recordPath, 'utf8')
    await assert.rejects(ctx.storageDomain.open(projectionCacheDomainSpec), (error) => {
      assert.ok(error instanceof Error && 'code' in error && 'syscall' in error && 'path' in error)
      assert.equal(error.code, 'EACCES')
      assert.equal(error.syscall, process.platform === 'win32' ? 'MoveFileExW' : 'open')
      assert.equal(typeof error.path, 'string')
      assert.equal(dirname(error.path), dirname(recordPath))
      assert.match(basename(error.path), /^\.[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.tmp$/)
      if (process.platform === 'win32') {
        assert.ok('dest' in error)
        assert.equal(error.dest, recordPath)
      }
      return true
    })
    assert.equal(await readFile(recordPath, 'utf8'), original)
    assert.equal(ctx.storageDomain.get(projectionCacheDomainSpec.name), undefined)
    assert.deepEqual(logs, [])
  } else {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(recoveryProjection)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60000 })
    const stored = await ctx.sessionPersistence.load(SessionId(id))
    assert.equal(ctx.sessionProjectionCache.cachedSnapshot(stored.meta), undefined)
    assert.deepEqual(ctx.sessionProjectionCache.coldSnapshot(stored.meta, stored.events), {
      asOfSeq: 1, values: { 'recovery/turns': 1 },
    })
  }
  await ctx.fiber.dispose()
  assert.deepEqual(logs, [])
} finally {
  if (originalUid === 0) {
    process.seteuid(originalUid)
    process.setegid(originalGid)
  }
}
