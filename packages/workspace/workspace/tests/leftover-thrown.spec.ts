import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry, { WorkspaceId, WorkspaceOrderInvalidError } from '../src/index.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

const leftoverSymbol = Symbol.for('leftover-workspace-registry')
const leftovers: Thrown[] = [
  { tag: 'leftover-object' },
  'leftover string',
  0,
  false,
  1n,
  leftoverSymbol,
  null,
  undefined,
]

const LIST_OK = Symbol('leftover-list-ok')

const leftoverHeader = (id: string, cwd: string, createdAt = 0): SessionHeader => ({
  version: 0,
  id: SessionId(id),
  createdAt,
  cwd,
})

interface LeftoverHarness {
  registry: WorkspaceRegistry
  pool: MemoryMediaPool
  refuseNextList: (leftover: Thrown) => void
}

/** Boot the real registry over memory storage with a leftover-capable header list. */
async function leftoverHarness(options: {
  pool?: MemoryMediaPool
  sessions?: SessionHeader[]
} = {}): Promise<LeftoverHarness> {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  const listed = options.sessions ?? []
  let leftoverList: Thrown | typeof LIST_OK = LIST_OK
  ctx.provide('sessionPersistence', {
    list: async () => {
      if (leftoverList !== LIST_OK) {
        const leftover = leftoverList
        leftoverList = LIST_OK
        throw leftover
      }
      return listed
    },
    load: (): never => {
      throw new Error('event bodies must not be loaded')
    },
    inspect: (): never => {
      throw new Error('event bodies must not be inspected')
    },
  } as never)

  await ctx.plugin(WorkspaceRegistry)
  return {
    registry: ctx.workspaceRegistry,
    pool,
    refuseNextList: (leftover: Thrown) => {
      leftoverList = leftover
    },
  }
}

let base: string | undefined
const tempDirs: string[] = []

async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-leftover-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined
})

describe('leftover Promise reject arms', () => {
  it('contains leftover Thrown create rejections so the next create lands', async () => {
    const dir = await makeDir('leftover-create')
    const pool = new MemoryMediaPool()
    const result = await leftoverHarness({ pool })
    for (const leftover of leftovers) {
      pool.leftoverWriteRejections.push(leftover)
      await expect(result.registry.create(dir)).rejects.toBe(leftover)
      expect(result.registry.list()).toEqual([])
    }
    const workspace = await result.registry.create(dir)
    expect(workspace.path).toBe(dir)
    expect(result.registry.list()).toEqual([workspace])
  })

  it('contains leftover Thrown persistence-list rejections so the next archive lands', async () => {
    const dir = await makeDir('leftover-archive')
    const result = await leftoverHarness({
      sessions: [leftoverHeader('kept', dir, 100)],
    })
    for (const leftover of leftovers) {
      result.refuseNextList(leftover)
      await expect(result.registry.archiveSession(SessionId('ghost'))).rejects.toBe(leftover)
      expect(result.registry.archivedSessionIds).toEqual([])
    }
    await result.registry.archiveSession(SessionId('kept'))
    expect(result.registry.archivedSessionIds).toEqual(['kept'])
  })

  it('forgets only the currently parked tail when operations overlap', async () => {
    const dir = await makeDir('stale-warm')
    const pool = new MemoryMediaPool()
    const result = await leftoverHarness({ pool })
    await result.registry.create(dir)
    const ghost = WorkspaceId('ghost')
    const first = result.registry.insertBefore(ghost)
    const second = result.registry.delete(ghost)
    const third = result.registry.delete(ghost)
    await expect(first).rejects.toBeInstanceOf(WorkspaceOrderInvalidError)
    await expect(second).resolves.toBe(false)
    await expect(third).resolves.toBe(false)
    expect(result.registry.list().map(entry => entry.path)).toEqual([dir])
  })
})
