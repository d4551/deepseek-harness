/**
 * The publish protocol behind every unit write. The Windows arm is driven with
 * a stubbed durable-move primitive so the platform decision is exercised on
 * every host, not only on a native Windows runner; the primitive's own Win32
 * flags are pinned by the dsh-atomic-write suite.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-atomic-'))
  roots.push(dir)
  return dir
}

/** One recorded durable replacement, or the errno the stub answers with. */
interface DurableMoveStub {
  calls: [string, string][]
  failure?: NodeJS.ErrnoException
}

/**
 * Replace the shared Windows durable-move primitive with a recording stub.
 * @param stub - recorder plus the optional failure it reports.
 */
function mockDurableMove(stub: DurableMoveStub): void {
  vi.resetModules()
  vi.doMock('@deepseek-ai/dsh-atomic-write/win32', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write/win32')>()
    return {
      ...actual,
      replaceFileDurablyWin32: (existing: string, replacement: string) => {
        stub.calls.push([existing, replacement])
        if (stub.failure !== undefined) return Promise.reject(stub.failure)
        renameSync(existing, replacement)
        return Promise.resolve()
      },
    }
  })
}

afterEach(async () => {
  vi.doUnmock('@deepseek-ai/dsh-atomic-write/win32')
  vi.resetModules()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('writeAtomic', () => {
  it('publishes through rename plus a parent-directory fsync on POSIX', async () => {
    const stub: DurableMoveStub = { calls: [] }
    mockDurableMove(stub)
    const { writeAtomic } = await import('../src/atomic.ts')
    const root = await tempRoot()
    const target = join(root, 'unit.json')
    await writeAtomic(target, '{"a":1}')
    await writeAtomic(target, '{"a":2}')
    expect(readFileSync(target, 'utf8')).toBe('{"a":2}')
    expect(readdirSync(root)).toEqual(['unit.json'])
    expect(stub.calls).toEqual([])
  })

  it('publishes through the write-through replacement on Windows, which has no directory fsync', async () => {
    const stub: DurableMoveStub = { calls: [] }
    mockDurableMove(stub)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const { writeAtomic } = await import('../src/atomic.ts')
      const root = await tempRoot()
      const target = join(root, 'unit.json')
      await writeAtomic(target, '{"a":1}')
      await writeAtomic(target, '{"a":2}')
      expect(readFileSync(target, 'utf8')).toBe('{"a":2}')
      expect(readdirSync(root)).toEqual(['unit.json'])
      expect(stub.calls.map(([, replacement]) => replacement)).toEqual([target, target])
    } finally {
      platform.mockRestore()
    }
  })

  it('removes the staging file and surfaces the errno when the Windows commit fails', async () => {
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' })
    const stub: DurableMoveStub = { calls: [], failure }
    mockDurableMove(stub)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const { writeAtomic } = await import('../src/atomic.ts')
      const root = await tempRoot()
      const target = join(root, 'unit.json')
      await expect(writeAtomic(target, '{}')).rejects.toMatchObject({ code: 'EACCES' })
      expect(existsSync(target)).toBe(false)
      expect(readdirSync(root)).toEqual([])
    } finally {
      platform.mockRestore()
    }
  })
})
