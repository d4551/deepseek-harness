import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { expect, it, onTestFinished } from 'vitest'
import SessionProjectionCache from '../src/index.ts'
import { projectionCacheDomainSpec } from '../src/spec.ts'
import { recoveryProjection } from './recovery-projection.ts'

it('denies snapshot reads before storage readiness and serves the same instance after initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cache-readiness-'))
  const ctx = new Context()
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(recoveryProjection)
  const meta = { version: 0, id: SessionId('readiness'), createdAt: 31, delegationDepth: 0 }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  const loading = ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  await Promise.resolve()
  const cache = ctx.get('sessionProjectionCache', false)
  if (!cache) throw new Error('Cache service was not constructed')
  expect(ctx.get('sessionProjectionCache')).toBeUndefined()
  expect(ctx.storageDomain.get(projectionCacheDomainSpec.name)).toBeUndefined()
  expect(() => cache.cachedSnapshot(meta)).toThrow('session projection cache is not initialized')
  expect(() => cache.coldSnapshot(meta, events)).toThrow('session projection cache is not initialized')
  expect(ctx.get('sessionProjectionCache')).toBeUndefined()
  expect(ctx.storageDomain.get(projectionCacheDomainSpec.name)).toBeUndefined()

  await loading
  expect(ctx.get('sessionProjectionCache')).toBeDefined()
  expect(ctx.storageDomain.get(projectionCacheDomainSpec.name)).toBeDefined()
  expect(cache.cachedSnapshot(meta)).toBeUndefined()
  expect(cache.coldSnapshot(meta, events)).toEqual({ asOfSeq: 1, values: { 'recovery/turns': 1 } })
})
