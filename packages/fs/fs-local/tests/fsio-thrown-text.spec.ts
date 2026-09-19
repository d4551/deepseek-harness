/**
 * Claim-boundary thrown-text rendering and leftover fs-local Promise reject arms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { resolveLocalTarget, writeFileAtomic } from '../src/fsio.ts'
import type { LocalTarget } from '../src/fsio.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fsio-thrown-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const localTarget = (path: string): LocalTarget => ({ displayPath: path, targetKey: FsTargetKey(path) })

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of chunks) out += chunk
  return out
}

describe('writeFileAtomic thrown-text rendering', () => {
  it.each([
    ['string-reason', 'string-reason'],
    [7, '7'],
    [false, 'false'],
    [1n, '1'],
    [Symbol.for('fs-local-thrown'), 'Symbol(fs-local-thrown)'],
    [undefined, 'undefined'],
    [null, 'null'],
    [{ no: 'message' }, '[object Object]'],
  ] as const)('renders a %s inspection throw as claim-boundary text', async (thrown, text) => {
    const file = join(dir, 'a.txt')
    const linkFailure = Object.assign(new Error('link failed'), { code: 'EIO' })
    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      linkFile: async () => { throw linkFailure },
      inspectPublicationTarget: async () => { throw thrown },
    }, { displayPath: file })).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot write "${file}": ${text}`,
      cause: thrown,
    })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('renders a function inspection throw as primitive String text', async () => {
    const file = join(dir, 'a.txt')
    const linkFailure = Object.assign(new Error('link failed'), { code: 'EIO' })
    const thrown = function inspectFailure() {}
    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      linkFile: async () => { throw linkFailure },
      inspectPublicationTarget: async () => { throw thrown },
    }, { displayPath: file })).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot write "${file}": ${String(thrown)}`,
      cause: thrown,
    })
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('combines a write failure with a staging cleanup failure', async () => {
    const file = join(dir, 'a.txt')
    const writeFailure = new Error('write exploded')
    const cleanupFailure = new Error('cleanup exploded')
    await expect(writeFileAtomic(file, 'ours', undefined, undefined, {
      inspectTemp: async () => { throw writeFailure },
      removeStagingDir: async () => { throw cleanupFailure },
    })).rejects.toMatchObject({
      code: 'FS_NOT_FOUND',
      message: 'write failed (write exploded) and temp cleanup failed (cleanup exploded)',
      cause: writeFailure,
    })
  })
})

describe('resolveLocalTarget leftover reject arms', () => {
  it('keeps the display path when every ancestor realpath is absent', async () => {
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async realpath() {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        },
      }
    })
    try {
      const { resolveLocalTarget: isolated } = await import('../src/fsio.ts')
      const target = await isolated(dir, 'missing.txt')
      expect(target.displayPath).toBe(join(dir, 'missing.txt'))
      expect(target.targetKey).toBe(join(dir, 'missing.txt'))
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('rethrows a non-ENOENT ancestor realpath failure', async () => {
    const denied = Object.assign(new Error('ancestor denied'), { code: 'EACCES' })
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async realpath(path: string) {
          if (path === join(dir, 'missing.txt')) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          }
          throw denied
        },
      }
    })
    try {
      const { resolveLocalTarget: isolated } = await import('../src/fsio.ts')
      await expect(isolated(dir, 'missing.txt')).rejects.toBe(denied)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('stats a win32 ancestor directory after an ENOENT realpath', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const target = await resolveLocalTarget(dir, 'missing.txt')
      expect(target.displayPath).toBe(join(dir, 'missing.txt'))
      expect(String(target.targetKey)).toBe(join(await realpath(dir), 'missing.txt'))
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
  })

  it('rejects a win32 file-valued ancestor after an ENOENT child realpath', async () => {
    const afile = join(dir, 'afile')
    await writeFile(afile, 'i am a file')
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async realpath(path: string) {
          if (path === join(afile, 'child.txt')) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          }
          return actual.realpath(path)
        },
      }
    })
    try {
      const { resolveLocalTarget: isolated } = await import('../src/fsio.ts')
      await expect(isolated(dir, 'afile/child.txt')).rejects.toMatchObject({
        code: 'FS_NOT_FOUND',
        message: `cannot resolve "${join(afile, 'child.txt')}": a parent path segment is not a directory`,
      })
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('continues a win32 ancestor walk when the ancestor stat is ENOENT', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      const realDir = await actual.realpath(dir)
      return {
        ...actual,
        async realpath(path: string) {
          if (path === join(dir, 'missing.txt')) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          }
          return actual.realpath(path)
        },
        async stat(path: string) {
          if (path === realDir) throw Object.assign(new Error('vanished'), { code: 'ENOENT' })
          return actual.stat(path)
        },
      }
    })
    try {
      const { resolveLocalTarget: isolated } = await import('../src/fsio.ts')
      const target = await isolated(dir, 'missing.txt')
      expect(target.displayPath).toBe(join(dir, 'missing.txt'))
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })
})

describe('listDirectory leftover reject arms', () => {
  it('preserves a structured FsError from the listing preflight', async () => {
    const root = join(dir, 'listed')
    await mkdir(root)
    vi.resetModules()
    const { FsError: IsolatedFsError } = await import('@deepseek-ai/dsh-fs')
    const listed = new IsolatedFsError('listed', 'FS_IO_ERROR')
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async stat(path: string, options?: Parameters<typeof actual.stat>[1]) {
          if (path === root) throw listed
          return actual.stat(path, options)
        },
      }
    })
    try {
      const { listDirectory: isolated } = await import('../src/fsio.ts')
      await expect(isolated(localTarget(root))).rejects.toBe(listed)
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('maps an ENOENT readdir to a structured not-found listing error', async () => {
    const root = join(dir, 'listed')
    await mkdir(root)
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async readdir() {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' })
        },
      }
    })
    try {
      const { listDirectory: isolated } = await import('../src/fsio.ts')
      await expect(isolated(localTarget(root))).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })
})

describe('decode leftover reject arms', () => {
  it('rethrows a non-TypeError from whole-file UTF-8 decode', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello')
    vi.resetModules()
    vi.doMock('node:util', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:util')>()
      return {
        ...actual,
        TextDecoder: class {
          decode() {
            throw new RangeError('forged decoder fault')
          }
        },
      }
    })
    try {
      const { readWholeText: isolated } = await import('../src/fsio.ts')
      await expect(isolated(localTarget(file))).rejects.toThrow('forged decoder fault')
    } finally {
      vi.doUnmock('node:util')
      vi.resetModules()
    }
  })

  it('rethrows a non-TypeError from streamed UTF-8 decode', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello')
    vi.resetModules()
    vi.doMock('node:util', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:util')>()
      return {
        ...actual,
        TextDecoder: class {
          decode() {
            throw new RangeError('forged stream decoder fault')
          }
        },
      }
    })
    try {
      const { streamWholeText: isolated } = await import('../src/fsio.ts')
      await expect(collect(isolated(localTarget(file)))).rejects.toThrow('forged stream decoder fault')
    } finally {
      vi.doUnmock('node:util')
      vi.resetModules()
    }
  })

  it('rethrows a non-TypeError from the diff-basis decoder', async () => {
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello')
    vi.resetModules()
    vi.doMock('node:util', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:util')>()
      return {
        ...actual,
        TextDecoder: class {
          decode() {
            throw new RangeError('forged basis decoder fault')
          }
        },
      }
    })
    try {
      const { readTextForDiff: isolated } = await import('../src/fsio.ts')
      await expect(isolated(file, 32)).rejects.toThrow('forged basis decoder fault')
    } finally {
      vi.doUnmock('node:util')
      vi.resetModules()
    }
  })
})

describe('writeFileAtomic leftover close reject arm', () => {
  it('maps a mid-write AbortError into FS_ABORTED after staging starts', async () => {
    const file = join(dir, 'a.txt')
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async open(...args: Parameters<typeof actual.open>) {
          const handle = await actual.open(...args)
          return {
            chmod: handle.chmod.bind(handle),
            writeFile: async () => {
              throw Object.assign(new Error('aborted'), { name: 'AbortError' })
            },
            sync: handle.sync.bind(handle),
            close: handle.close.bind(handle),
          }
        },
      }
    })
    try {
      const { writeFileAtomic: isolated } = await import('../src/fsio.ts')
      await expect(isolated(file, 'ours', undefined, undefined)).rejects.toMatchObject({ code: 'FS_ABORTED' })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })

  it('combines a write failure with a temp close failure', async () => {
    const file = join(dir, 'a.txt')
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        async open(...args: Parameters<typeof actual.open>) {
          const handle = await actual.open(...args)
          return {
            chmod: handle.chmod.bind(handle),
            writeFile: handle.writeFile.bind(handle),
            sync: handle.sync.bind(handle),
            close: async () => {
              throw new Error('close exploded')
            },
          }
        },
      }
    })
    try {
      const { writeFileAtomic: isolated } = await import('../src/fsio.ts')
      await expect(isolated(file, 'ours', undefined, undefined, {
        inspectTemp: async () => { throw new Error('write exploded') },
      })).rejects.toMatchObject({
        code: 'FS_NOT_FOUND',
        message: 'write failed (write exploded) and temp close failed (close exploded)',
      })
    } finally {
      vi.doUnmock('node:fs/promises')
      vi.resetModules()
    }
  })
})
