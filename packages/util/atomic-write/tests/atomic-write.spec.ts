import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { MakeDirectoryOptions, PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock, writeFileAtomic } from '../src/index.ts'

const state = vi.hoisted(() => ({
  failLockCreateWithNull: false,
  failLockCreateWithEPERM: false,
  lockCreateErrorCode: '',
  failTempWriteWithCode: '',
  fixedTempSuffix: '',
  mkdirCalls: [] as Array<[PathLike, MakeDirectoryOptions | undefined]>,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (async (path: PathLike, ...rest: never[]) => {
      if (state.failLockCreateWithNull && String(path).endsWith('.lock')) {
        state.failLockCreateWithNull = false
        // A throw site is not obliged to throw an Error; `catch` binds whatever
        // was thrown, including null.
        throw null
      }
      if (state.failLockCreateWithEPERM && String(path).endsWith('.lock')) {
        state.failLockCreateWithEPERM = false
        throw Object.assign(new Error('EPERM: injected exclusive-create failure'), { code: 'EPERM' })
      }
      if (state.lockCreateErrorCode !== '' && String(path).endsWith('.lock')) {
        const code = state.lockCreateErrorCode
        throw Object.assign(new Error(`${code}: injected exclusive-create failure`), { code })
      }
      if (state.failTempWriteWithCode !== '' && String(path).endsWith('.tmp')) {
        const code = state.failTempWriteWithCode
        throw Object.assign(new Error(`${code}: injected temp-create failure`), { code })
      }
      return (actual.writeFile as (path: PathLike, ...args: never[]) => Promise<void>)(path, ...rest)
    }) as typeof actual.writeFile,
    mkdir: (async (path: PathLike, options?: MakeDirectoryOptions) => {
      state.mkdirCalls.push([path, options])
      return (actual.mkdir as (path: PathLike, options: MakeDirectoryOptions | undefined) => Promise<string | undefined>)(path, options)
    }) as typeof actual.mkdir,
  }
})

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (size: number) => (state.fixedTempSuffix === ''
      ? actual.randomBytes(size)
      : Buffer.from(state.fixedTempSuffix, 'hex')),
  }
})

afterEach(() => {
  state.failLockCreateWithNull = false
  state.failLockCreateWithEPERM = false
  state.lockCreateErrorCode = ''
  state.failTempWriteWithCode = ''
  state.fixedTempSuffix = ''
  state.mkdirCalls = []
})

let scratchRoot: string | undefined

afterEach(async () => {
  if (scratchRoot !== undefined) await rm(scratchRoot, { recursive: true, force: true })
  scratchRoot = undefined
})

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
}

/**
 * Run one test body inside a scratch directory that the `afterEach` hook
 * removes, whether the body passes or fails. The second argument is the
 * standard `settings.json` subject most tests in this file exercise.
 */
async function withScratch(run: (root: string, target: string) => Promise<void>): Promise<void> {
  const root = await scratch()
  scratchRoot = root
  await run(root, join(root, 'settings.json'))
}

/**
 * Assert a path's permission bits exactly. Windows synthesizes only part of
 * the POSIX mode bits, so the assertion is decided on the other platforms.
 */
async function expectFileMode(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return
  expect((await stat(path)).mode & 0o777).toBe(mode)
}

/** Assert a lock acquisition fails with the protocol's timeout error. */
function expectLockTimeout<T>(acquisition: Promise<T>): Promise<void> {
  return expect(acquisition).rejects.toThrow(/timed out waiting for the writer lock/)
}

/** Attempt a lock-holding write whose operation must never run, under the short wait. */
function attemptLockedWrite(target: string): Promise<string> {
  return withFileLock(target, async () => 'unreachable', { waitMs: 50 })
}

/** Resolve once the lockfile exists, so contention is measured against a held lock. */
async function waitForLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      await stat(lockPath)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

describe('writeFileAtomic', () => {
  it('creates the file and its parents with exactly the stated mode', async () => {
    await withScratch(async (dir) => {
      const target = join(dir, 'nested', 'deep', 'doc.yaml')
      await writeFileAtomic(target, 'a: 1\n', { mode: 0o600 })
      expect(await readFile(target, 'utf8')).toBe('a: 1\n')
      await expectFileMode(target, 0o600)
    })
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    await withScratch(async (dir) => {
      const target = join(dir, 'doc.yaml')
      await writeFile(target, 'old', { mode: 0o644 })
      await writeFileAtomic(target, 'new', { mode: 0o600 })
      expect(await readFile(target, 'utf8')).toBe('new')
      await expectFileMode(target, 0o600)
    })
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    await withScratch(async (dir) => {
      const victim = join(dir, 'victim')
      await writeFile(victim, 'victim-content')
      const target = join(dir, 'doc.yaml')
      await symlink(victim, target)
      await writeFileAtomic(target, 'replaced', { mode: 0o600 })
      expect((await lstat(target)).isSymbolicLink()).toBe(false)
      expect(await readFile(target, 'utf8')).toBe('replaced')
      expect(await readFile(victim, 'utf8')).toBe('victim-content')
    })
  })

  it('leaves no temp sibling and rethrows when the rename fails', async () => {
    await withScratch(async (dir) => {
      const target = join(dir, 'occupied')
      await mkdir(target)
      await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toThrow()
      expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
    })
  })
})

describe('withFileLock', () => {
  it('retries EPERM only when the lock path currently exists', async () => {
    await withScratch(async (dir) => {
      const target = join(dir, 'document')
      const lockPath = `${target}.lock`
      await writeFile(lockPath, 'holder\n')
      // The lock is released mid-test by removing its file. Removal of an
      // already-removed path is a no-op under `force`, so the awaited release
      // cannot fail in practice.
      const release = (async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        await rm(lockPath, { force: true })
      })()
      state.failLockCreateWithEPERM = true
      let called = false

      await withFileLock(target, async () => { called = true })
      await release
      expect(called).toBe(true)
    })
  })

  it('preserves EPERM when no lock path exists', async () => {
    await withScratch(async (dir) => {
      const operation = vi.fn(async () => {})
      state.failLockCreateWithEPERM = true

      await expect(withFileLock(join(dir, 'document'), operation)).rejects.toMatchObject({ code: 'EPERM' })
      expect(operation).not.toHaveBeenCalled()
    })
  })

  it('rejects an invalid parent hierarchy before running the operation', async () => {
    await withScratch(async (dir) => {
      const parent = join(dir, 'not-a-directory')
      await writeFile(parent, 'occupied')
      let called = false

      await expect(withFileLock(join(parent, 'document'), async () => {
        called = true
      })).rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
      expect(called).toBe(false)
    })
  })

  it('waits for the caller-stated limit rather than the protocol default', async () => {
    // An operation whose work includes a network round trip legitimately holds
    // the lock far longer than the render-and-rename the default was sized
    // for. The limit is per call so one such operation cannot fail every other
    // writer of the same file, and a caller that states a short one still
    // fails fast.
    await withScratch(async (dir) => {
      const target = join(dir, 'document')
      let release = (): void => {}
      const held = new Promise<void>((resolve) => { release = resolve })
      const holder = withFileLock(target, () => held)
      // The holder owns the lock once its lockfile exists; contending before
      // that would measure nothing.
      await waitForLock(`${target}.lock`)

      // Elapsed time is the assertion that distinguishes a honoured limit from
      // the ignored argument: without it the contender simply waits out the
      // protocol default and fails with the same message.
      const startedAt = Date.now()
      await expectLockTimeout(withFileLock(target, async () => 'impatient', { waitMs: 50 }))
      expect(Date.now() - startedAt).toBeLessThan(1_000)

      const patient = withFileLock(target, async () => 'patient', { waitMs: 10_000 })
      release()
      await holder
      expect(await patient).toBe('patient')
    })
  })
})

describe('atomic write directory mode and lock lifecycle', () => {
  it('creates every missing parent level with the requested mode', async () => {
    await withScratch(async (root) => {
      const target = join(root, 'nested', 'deep', 'settings.json')
      await writeFileAtomic(target, '{}', { mode: 0o600, dirMode: 0o700 })

      await expectFileMode(join(root, 'nested'), 0o700)
      await expectFileMode(join(root, 'nested', 'deep'), 0o700)
      expect(await readFile(target, 'utf8')).toBe('{}')
    })
  })

  it('leaves the platform default in place when no directory mode is requested', async () => {
    await withScratch(async (root) => {
      const target = join(root, 'plain', 'settings.json')
      await writeFileAtomic(target, '{}', { mode: 0o600 })

      // 0o700 is what the explicit case asks for, so a default that equals it
      // would make the mode assertion above vacuous.
      if (process.platform !== 'win32') expect((await stat(join(root, 'plain'))).mode & 0o777).not.toBe(0o700)
    })
  })

  it('passes mkdir exactly the options object each dirMode case declares', async () => {
    await withScratch(async (root) => {
      await writeFileAtomic(join(root, 'plain', 'settings.json'), '{}', { mode: 0o600 })
      await writeFileAtomic(join(root, 'stated', 'settings.json'), '{}', { mode: 0o600, dirMode: 0o700 })

      expect(state.mkdirCalls.filter(([path]) => String(path) === join(root, 'plain')))
        .toStrictEqual([[join(root, 'plain'), { recursive: true }]])
      expect(state.mkdirCalls.filter(([path]) => String(path) === join(root, 'stated')))
        .toStrictEqual([[join(root, 'stated'), { recursive: true, mode: 0o700 }]])
    })
  })

  it('writes the holding process id into the lock file', async () => {
    await withScratch(async (_root, target) => {
      const held = await withFileLock(target, async () => readFile(`${target}.lock`, 'utf8'))

      expect(held).toBe(`${process.pid}\n`)
    })
  })

  it('releases cleanly when the operation removed the lock file itself', async () => {
    await withScratch(async (_root, target) => {
      await expect(withFileLock(target, async () => {
        await rm(`${target}.lock`)
        return 'done'
      })).resolves.toBe('done')
    })
  })

  it('surfaces a non-contention lock failure even when the lock file exists', async () => {
    await withScratch(async (_root, target) => {
      // An existing lock plus a code that is neither EEXIST nor EPERM is a real
      // failure, not contention: retrying it would hide the cause behind a
      // timeout.
      await writeFile(`${target}.lock`, 'held\n')
      state.lockCreateErrorCode = 'EACCES'
      await expect(attemptLockedWrite(target)).rejects.toMatchObject({ code: 'EACCES' })
    })
  })
})

describe('atomic write temp-file exclusivity and failure cleanup', () => {
  it('refuses to overwrite an existing temp file instead of clobbering it', async () => {
    await withScratch(async (_root, target) => {
      state.fixedTempSuffix = 'aabbccddeeff'
      const temp = `${target}.aabbccddeeff.tmp`
      // A concurrent writer already owns this temp name. Exclusive creation is
      // what stops the second writer from renaming the first one's bytes over
      // the target.
      await writeFile(temp, 'other writer')

      await expect(writeFileAtomic(target, 'mine', { mode: 0o600 }))
        .rejects.toMatchObject({ code: 'EEXIST' })
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('reports the write failure itself when no temp file was left behind', async () => {
    await withScratch(async (_root, target) => {
      state.failTempWriteWithCode = 'ENOSPC'
      // Cleanup runs whether or not the temp exists, so the caller sees the
      // original failure rather than an ENOENT from the removal.
      await expect(writeFileAtomic(target, '{}', { mode: 0o600 }))
        .rejects.toMatchObject({ code: 'ENOSPC' })
    })
  })
})

describe('writer lock deadline and backoff', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives up the moment the wait reaches its deadline, not after it', async () => {
    await withScratch(async (_root, target) => {
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now')
      const targetLock = `${target}.lock`
      await writeFile(targetLock, 'held\n')
      // The deadline is computed from the first reading; every later reading
      // lands exactly on it. Waiting "until" the deadline must stop there —
      // treating equality as still-waiting never terminates.
      clock.mockReturnValueOnce(now).mockReturnValue(now + 50)

      await expectLockTimeout(attemptLockedWrite(target))
    })
  })

  it('doubles the retry delay up to the cap while it waits', async () => {
    await withScratch(async (_root, target) => {
      const delays: number[] = []
      const realSetTimeout = globalThis.setTimeout
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        handler: TimerHandler, timeout?: number, ...rest: never[]
      ) => {
        delays.push(timeout ?? 0)
        // Run the retry immediately: the sequence under test is the delay
        // values, not the wall-clock time spent sleeping through them.
        return realSetTimeout(handler, 0, ...rest)
      }) as typeof globalThis.setTimeout)
      const targetLock = `${target}.lock`
      await writeFile(targetLock, 'held\n')

      await expectLockTimeout(withFileLock(target, async () => 'unreachable', { waitMs: 700 }))
      expect(delays.slice(0, 5)).toEqual([20, 40, 80, 160, 200])
      expect(delays.every(delay => delay <= 200)).toBe(true)
    })
  })
})

describe('writer lock non-Error throws', () => {
  it('surfaces a thrown null rather than reading a code off it', async () => {
    await withScratch(async (_root, target) => {
      state.failLockCreateWithNull = true

      // The original value reaches the caller: reading `.code` off it would
      // replace the real failure with a TypeError from this package.
      await expect(attemptLockedWrite(target)).rejects.toBeNull()
    })
  })
})
