/**
 * The Windows publication path for content-addressed objects. Windows exposes
 * no parent-directory fsync, so every directory and object entry must be
 * created through the write-through namespace primitives instead of being
 * created and then left unsynced. The primitives are stubbed with real
 * filesystem operations so the store's platform decision — and its staging
 * hygiene on both the fresh and the deduplicating path — is exercised on every
 * host; the Win32 flags themselves are pinned by the dsh-atomic-write suite.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { NormalizationPolicy } from '../src/normalization.ts'

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
))

const POLICY: NormalizationPolicy = { maxPixels: 2048 * 2048, maxDimension: 8192, maxBytes: 1024 * 1024 }

const LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2048,
  maxImagePixels: 16,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const roots: string[] = []

/** Calls the store made through the Windows durable-namespace primitives. */
interface DurableCalls {
  directories: string[]
  publications: [string, string][]
}

/**
 * Replace the Windows namespace primitives with real filesystem work that
 * keeps their published contracts: directories appear, and publishing over an
 * existing name fails with `EEXIST` instead of clobbering it.
 * @param calls - recorder for the store's use of each primitive.
 */
function mockDurableNamespace(calls: DurableCalls): void {
  vi.resetModules()
  vi.doMock('@deepseek-ai/dsh-atomic-write/win32', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write/win32')>()
    return {
      ...actual,
      async ensureDurableDirectoryWin32(target: string): Promise<void> {
        calls.directories.push(target)
        await mkdir(target, { recursive: true, mode: 0o700 })
      },
      async publishNewFileWin32(existing: string, replacement: string): Promise<void> {
        calls.publications.push([existing, replacement])
        if (existsSync(replacement)) {
          throw Object.assign(new Error(`MoveFileExW EEXIST: ${existing} -> ${replacement}`), { code: 'EEXIST' })
        }
        await rename(existing, replacement)
      },
    }
  })
}

async function storageRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-attachment-win32-'))
  roots.push(value)
  return join(value, 'attachments', 'v1')
}

afterEach(async () => {
  vi.doUnmock('@deepseek-ai/dsh-atomic-write/win32')
  vi.resetModules()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('the Windows attachment publication path', () => {
  it('creates every directory and the object itself through write-through publication', async () => {
    const calls: DurableCalls = { directories: [], publications: [] }
    mockDurableNamespace(calls)
    // sharp selects its native runtime from process.platform at module load,
    // so the store (and its image dependency) load before the spy goes up.
    const { readImageFile, saveImageFile } = await import('../src/store.ts')
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const root = await storageRoot()
      const sha256 = createHash('sha256').update(PNG).digest('hex')
      const object = join(root, 'objects', sha256.slice(0, 2), sha256)

      const ref = await saveImageFile(root, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)

      await expect(readImageFile(root, ref)).resolves.toEqual({ ref, data: PNG })
      expect(calls.directories).toContain(join(root, 'objects', sha256.slice(0, 2)))
      expect(calls.directories).toContain(join(root, 'tmp'))
      expect(calls.publications.map(([, replacement]) => replacement)).toEqual([object])
      // The move consumed the staging name; nothing is left to leak or resync.
      expect(readdirSync(join(root, 'tmp'))).toEqual([])
    } finally {
      platform.mockRestore()
    }
  })

  it('keeps the stored object and drops the staging file when another writer won the race', async () => {
    const calls: DurableCalls = { directories: [], publications: [] }
    mockDurableNamespace(calls)
    const { readImageFile, saveImageFile } = await import('../src/store.ts')
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const root = await storageRoot()

      const first = await saveImageFile(root, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)
      const second = await saveImageFile(root, { data: PNG, mediaType: 'image/png' }, LIMITS, POLICY)

      expect(second.attachmentId).toBe(first.attachmentId)
      expect(calls.publications).toHaveLength(2)
      await expect(readImageFile(root, second)).resolves.toEqual({ ref: second, data: PNG })
      expect(readdirSync(join(root, 'tmp'))).toEqual([])
    } finally {
      platform.mockRestore()
    }
  })
})
