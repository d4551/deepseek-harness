/**
 * Unit tests for the shared Windows durable-publication helpers with a mocked
 * kernel32 binding. The JSONL, storage, and attachment backends consume them on
 * native Windows; these tests keep the Win32 error mapping, flag selection, and
 * race handling covered on every host.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'

const MOVEFILE_REPLACE_EXISTING = 0x00000001
const MOVEFILE_WRITE_THROUGH = 0x00000008
const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_NOT_SAME_DEVICE = 17
const ERROR_FILE_EXISTS = 80
const ERROR_INVALID_NAME = 123
const ERROR_ALREADY_EXISTS = 183

type MoveFileExW = (existing: string, replacement: string, flags: number, setLastError: (code: number) => void) => number

const roots: string[] = []

function stripNamespace(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length)
  return path
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-durable-win32-'))
  roots.push(dir)
  return dir
}

async function importWithMove(moveFileExW: MoveFileExW): Promise<typeof import('../src/win32.ts')> {
  vi.resetModules()
  vi.doMock('koffi', () => {
    let lastError = 0
    const setLastError = (code: number): void => { lastError = code }
    const move: MoveFileExW = (existing, replacement, flags, setError) => {
      const ok = moveFileExW(existing, replacement, flags, setError)
      lastError = ok === 0 ? lastError : 0
      return ok
    }
    return {
      default: {
        load: () => ({
          func: (_convention: string, name: string, result: string) => {
            if (name === 'MoveFileExW') return (existing: string, replacement: string, flags: number) => {
              expect(result).toBe('int')
              const ok = move(existing, replacement, flags, setLastError)
              return ok
            }
            return () => lastError
          },
        }),
      },
    }
  })
  return import('../src/win32.ts')
}

async function importWithError(code: number): Promise<typeof import('../src/win32.ts')> {
  vi.resetModules()
  vi.doMock('koffi', () => ({
    default: {
      load: () => ({
        func: (_convention: string, name: string) => {
          if (name === 'MoveFileExW') return () => 0
          return () => code
        },
      }),
    },
  }))
  return import('../src/win32.ts')
}

async function importWithFilesystemMove(): Promise<typeof import('../src/win32.ts')> {
  return importWithMove((existing, replacement, flags, setLastError) => {
    expect(flags).toBe(MOVEFILE_WRITE_THROUGH)
    const from = stripNamespace(existing)
    const to = stripNamespace(replacement)
    if (!existsSync(from)) { setLastError(ERROR_FILE_NOT_FOUND); return 0 }
    if (existsSync(to)) { setLastError(ERROR_ALREADY_EXISTS); return 0 }
    renameSync(from, to)
    return 1
  })
}

afterEach(async () => {
  vi.doUnmock('koffi')
  vi.doUnmock('node:fs/promises')
  vi.doUnmock('node:path')
  vi.resetModules()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('the atomic write commit on Windows', () => {
  it('commits through the write-through move instead of a rename plus directory fsync', async () => {
    const flagsSeen: number[] = []
    vi.resetModules()
    vi.doMock('koffi', () => {
      let lastError = 0
      return {
        default: {
          load: () => ({
            func: (_convention: string, name: string) => {
              if (name === 'MoveFileExW') return (existing: string, replacement: string, flags: number) => {
                flagsSeen.push(flags)
                const from = stripNamespace(existing)
                const to = stripNamespace(replacement)
                if (!existsSync(from)) { lastError = ERROR_FILE_NOT_FOUND; return 0 }
                renameSync(from, to)
                return 1
              }
              return () => lastError
            },
          }),
        },
      }
    })
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const { writeFileAtomic } = await import('../src/index.ts')
      const root = await tempRoot()
      const target = join(root, 'settings.json')
      await writeFileAtomic(target, 'first', { mode: 0o600 })
      await writeFileAtomic(target, 'second', { mode: 0o600 })
      expect(readFileSync(target, 'utf8')).toBe('second')
      expect(flagsSeen).toEqual([
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
      ])
      // No staging residue: the move consumed the temp name.
      expect(readdirSync(root)).toEqual(['settings.json'])
    } finally {
      platform.mockRestore()
    }
  })

  it('reports a failed Windows commit as the errno the write returns', async () => {
    vi.resetModules()
    vi.doMock('koffi', () => ({
      default: {
        load: () => ({
          func: (_convention: string, name: string) => {
            if (name === 'MoveFileExW') return () => 0
            return () => ERROR_ACCESS_DENIED
          },
        }),
      },
    }))
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      const { writeFileAtomic } = await import('../src/index.ts')
      const root = await tempRoot()
      await expect(writeFileAtomic(join(root, 'settings.json'), 'x', { mode: 0o600 }))
        .rejects.toMatchObject({ code: 'EACCES' })
      // The failed commit leaves no staging file behind.
      expect(readdirSync(root)).toEqual([])
    } finally {
      platform.mockRestore()
    }
  })
})

describe('Windows durable namespace helpers', () => {
  it('keeps drive-root probes native while namespacing descendants', async () => {
    const probes: string[] = []
    vi.resetModules()
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        stat: async (path: string) => {
          probes.push(path)
          return { isDirectory: () => true }
        },
      }
    })
    vi.doMock('node:path', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:path')>()
      return {
        ...actual,
        join: (...paths: string[]) => actual.win32.join(...paths),
        parse: (path: string) => actual.win32.parse(path),
        resolve: (...paths: string[]) => actual.win32.resolve(...paths),
        toNamespacedPath: (path: string) => actual.win32.toNamespacedPath(path),
      }
    })
    const { ensureDurableDirectoryWin32 } = await import('../src/win32.ts')

    await ensureDurableDirectoryWin32('C:\\existing')

    expect(probes).toEqual(['C:\\', '\\\\?\\C:\\existing'])
  })

  it('publishes a new file with write-through MoveFileExW semantics', async () => {
    const { publishNewFileWin32 } = await importWithFilesystemMove()
    const root = await tempRoot()
    const tmp = join(root, 'log.tmp')
    const final = join(root, 'log.jsonl')
    await writeFile(tmp, 'content')

    await publishNewFileWin32(tmp, final)
    expect(existsSync(tmp)).toBe(false)
    expect(readFileSync(final, 'utf8')).toBe('content')
  })

  it('replaces an existing target durably, which the publish flag alone refuses', async () => {
    const flagsSeen: number[] = []
    const { publishNewFileWin32, replaceFileDurablyWin32 } = await importWithMove((existing, replacement, flags, setLastError) => {
      flagsSeen.push(flags)
      const from = stripNamespace(existing)
      const to = stripNamespace(replacement)
      if (existsSync(to) && (flags & MOVEFILE_REPLACE_EXISTING) === 0) { setLastError(ERROR_ALREADY_EXISTS); return 0 }
      renameSync(from, to)
      return 1
    })
    const root = await tempRoot()
    const target = join(root, 'settings.json')
    writeFileSync(target, 'old')

    const stale = join(root, 'stale.tmp')
    writeFileSync(stale, 'next')
    await expect(publishNewFileWin32(stale, target)).rejects.toMatchObject({ code: 'EEXIST' })

    const fresh = join(root, 'fresh.tmp')
    writeFileSync(fresh, 'next')
    await replaceFileDurablyWin32(fresh, target)

    expect(readFileSync(target, 'utf8')).toBe('next')
    // Every commit is write-through: the entry swap is flushed before the call
    // returns, which is what replaces the POSIX parent-directory fsync.
    expect(flagsSeen).toEqual([
      MOVEFILE_WRITE_THROUGH,
      MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
    ])
  })

  it('maps Win32 publish failures to Node-style errno codes', async () => {
    const cases = [
      [ERROR_FILE_NOT_FOUND, 'ENOENT'],
      [ERROR_PATH_NOT_FOUND, 'ENOENT'],
      [ERROR_ACCESS_DENIED, 'EACCES'],
      [ERROR_NOT_SAME_DEVICE, 'EXDEV'],
      [ERROR_FILE_EXISTS, 'EEXIST'],
      [ERROR_ALREADY_EXISTS, 'EEXIST'],
      [ERROR_INVALID_NAME, 'EINVAL'],
      [9999, 'EIO'],
    ] as const
    for (const [win32Code, code] of cases) {
      const { publishNewFileWin32 } = await importWithError(win32Code)
      await expect(publishNewFileWin32('from', 'to')).rejects.toMatchObject({ code, win32Code, path: 'from', dest: 'to' })
    }
  })

  it('creates missing directories through staging siblings and tolerates an already-created race', async () => {
    const root = await tempRoot()
    const raced = join(root, 'raced')
    const { ensureDurableDirectoryWin32 } = await importWithMove((existing, replacement, flags, setLastError) => {
      expect(flags).toBe(MOVEFILE_WRITE_THROUGH)
      const from = stripNamespace(existing)
      const to = stripNamespace(replacement)
      if (to === raced) {
        mkdirSync(to)
        setLastError(ERROR_ALREADY_EXISTS)
        return 0
      }
      if (!existsSync(from)) { setLastError(ERROR_FILE_NOT_FOUND); return 0 }
      if (existsSync(to)) { setLastError(ERROR_ALREADY_EXISTS); return 0 }
      renameSync(from, to)
      return 1
    })

    await ensureDurableDirectoryWin32(join(root, 'a', 'b'))
    expect(existsSync(join(root, 'a', 'b'))).toBe(true)
    await ensureDurableDirectoryWin32(join(root, 'a', 'b'))
    await ensureDurableDirectoryWin32(raced)
    expect(existsSync(raced)).toBe(true)
  })

  it('keeps staging names valid for a maximum-length target component', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithFilesystemMove()
    const root = await tempRoot()
    const target = join(root, 'x'.repeat(255))

    await ensureDurableDirectoryWin32(target)
    expect(existsSync(target)).toBe(true)
  })

  it('surfaces directory publication failures other than an existing-target race', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithError(ERROR_ACCESS_DENIED)
    const root = await tempRoot()

    await expect(ensureDurableDirectoryWin32(join(root, 'denied'))).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rejects a non-directory component instead of treating it as missing', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithFilesystemMove()
    const root = await tempRoot()
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'x')

    await expect(ensureDurableDirectoryWin32(join(blocked, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('Windows binding and failure identity', () => {
  it('loads kernel32 by name, once, however many calls follow', async () => {
    const loaded: string[] = []
    vi.resetModules()
    vi.doMock('koffi', () => ({
      default: {
        load: (library: string) => {
          loaded.push(library)
          return { func: (_convention: string, name: string) => (name === 'MoveFileExW' ? () => 1 : () => 0) }
        },
      },
    }))
    const { publishNewFileWin32 } = await import('../src/win32.ts')

    await publishNewFileWin32('from', 'to')
    await publishNewFileWin32('other', 'elsewhere')
    // One entry proves the cache: reloading kernel32 per call would rebind the
    // function pointers on every publish.
    expect(loaded).toEqual(['kernel32.dll'])
  })

  it('names MoveFileExW as the failing syscall', async () => {
    const { publishNewFileWin32 } = await importWithError(ERROR_ACCESS_DENIED)
    await expect(publishNewFileWin32('from', 'to')).rejects.toMatchObject({ syscall: 'MoveFileExW' })
  })
})

describe('Windows durable directory failure handling', () => {
  it('rethrows a directory probe failure that is not a missing path', async () => {
    // The probe reads `code` off whatever was thrown, and a thrown null is why
    // that read is optional: reading through it would replace the driver's
    // failure with a TypeError.
    for (const thrown of [null, Object.assign(new Error('denied'), { code: 'EACCES' })]) {
      vi.resetModules()
      vi.doMock('node:fs/promises', async importOriginal => ({
        ...await importOriginal<typeof import('node:fs/promises')>(),
        stat: async () => { throw thrown },
      }))
      const { ensureDurableDirectoryWin32 } = await import('../src/win32.ts')
      await expect(ensureDurableDirectoryWin32('/tmp/dsh-probe')).rejects.toBe(thrown)
    }
  })

  it('refuses a path whose component already exists as a file', async () => {
    const { ensureDurableDirectoryWin32 } = await importWithFilesystemMove()
    const root = await tempRoot()
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory')

    await expect(ensureDurableDirectoryWin32(join(blocker, 'child')))
      .rejects.toThrow('path exists but is not a directory')
  })

  it('surfaces a publication failure even when the target is already a directory', async () => {
    const root = await tempRoot()
    const target = join(root, 'blocked')
    const { ensureDurableDirectoryWin32 } = await importWithMove((existing, replacement, _flags, setLastError) => {
      const from = stripNamespace(existing)
      const to = stripNamespace(replacement)
      if (to === target) {
        // Another writer wins the name, and the publish fails for an unrelated
        // reason: a directory at the target does not excuse that failure.
        mkdirSync(to)
        setLastError(ERROR_ACCESS_DENIED)
        return 0
      }
      renameSync(from, to)
      return 1
    })

    await expect(ensureDurableDirectoryWin32(target)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses an existing-target race whose winner is not a directory', async () => {
    const root = await tempRoot()
    const target = join(root, 'winner')
    const { ensureDurableDirectoryWin32 } = await importWithMove((existing, replacement, _flags, setLastError) => {
      const from = stripNamespace(existing)
      const to = stripNamespace(replacement)
      if (to === target) {
        writeFileSync(to, 'a file took the name')
        setLastError(ERROR_ALREADY_EXISTS)
        return 0
      }
      renameSync(from, to)
      return 1
    })

    await expect(ensureDurableDirectoryWin32(target)).rejects.toThrow('path exists but is not a directory')
  })

  it('rethrows a publish failure thrown as null', async () => {
    vi.resetModules()
    vi.doMock('koffi', () => ({
      default: {
        load: () => ({
          func: (_convention: string, name: string) => (name === 'MoveFileExW'
            ? () => { throw null }
            : () => 0),
        }),
      },
    }))
    const { ensureDurableDirectoryWin32 } = await import('../src/win32.ts')
    const root = await tempRoot()

    await expect(ensureDurableDirectoryWin32(join(root, 'leaf'))).rejects.toBeNull()
  })

  it('probes a path that is already the filesystem root exactly once', async () => {
    // Slicing the root off leaves an empty remainder, which must produce no
    // segments: one that survived would re-probe the root as its own child.
    const probes: string[] = []
    vi.resetModules()
    vi.doMock('node:fs/promises', async importOriginal => ({
      ...await importOriginal<typeof import('node:fs/promises')>(),
      stat: (path: string) => {
        probes.push(path)
        return Promise.resolve({ isDirectory: () => true })
      },
    }))
    const { ensureDurableDirectoryWin32 } = await import('../src/win32.ts')
    const root = parse(process.cwd()).root

    await ensureDurableDirectoryWin32(root)
    expect(probes).toEqual([root])
  })

  it('stages under a name that does not derive from the target', async () => {
    const staged: string[] = []
    const { ensureDurableDirectoryWin32 } = await importWithMove((existing, replacement, _flags, setLastError) => {
      const from = stripNamespace(existing)
      const to = stripNamespace(replacement)
      staged.push(basename(from))
      if (!existsSync(from)) { setLastError(ERROR_FILE_NOT_FOUND); return 0 }
      renameSync(from, to)
      return 1
    })
    const root = await tempRoot()

    await ensureDurableDirectoryWin32(join(root, 'leaf'))
    expect(staged.length).toBeGreaterThan(0)
    for (const name of staged) expect(name.startsWith('.dsh-mkdir-')).toBe(true)
  })
})
