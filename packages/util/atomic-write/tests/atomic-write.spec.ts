import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
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
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: (async (path: unknown, ...rest: never[]) => {
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
      return (actual.writeFile as (path: unknown, ...args: never[]) => Promise<void>)(path, ...rest)
    }) as typeof actual.writeFile,
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
})

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
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
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, 'new', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'victim-content')
    const target = join(dir, 'doc.yaml')
    await symlink(victim, target)
    await writeFileAtomic(target, 'replaced', { mode: 0o600 })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('replaced')
    expect(await readFile(victim, 'utf8')).toBe('victim-content')
  })

  it('leaves no temp sibling and rethrows when the rename fails', async () => {
    const dir = await scratch()
    const target = join(dir, 'occupied')
    await mkdir(target)
    await expect(writeFileAtomic(target, 'content', { mode: 0o600 })).rejects.toThrow()
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })
})

describe('withFileLock', () => {
  it('retries EPERM only when the lock path currently exists', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`
    await writeFile(lockPath, 'holder\n')
    const release = setTimeout(() => { void rm(lockPath, { force: true }) }, 50)
    state.failLockCreateWithEPERM = true
    let called = false

    try {
      await withFileLock(target, async () => { called = true })
    } finally {
      clearTimeout(release)
    }
    expect(called).toBe(true)
  })

  it('preserves EPERM when no lock path exists', async () => {
    const dir = await scratch()
    const operation = vi.fn(async () => {})
    state.failLockCreateWithEPERM = true

    await expect(withFileLock(join(dir, 'document'), operation)).rejects.toMatchObject({ code: 'EPERM' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('rejects an invalid parent hierarchy before running the operation', async () => {
    const dir = await scratch()
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'occupied')
    let called = false

    await expect(withFileLock(join(parent, 'document'), async () => {
      called = true
    })).rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
    expect(called).toBe(false)
  })

  it('waits for the caller-stated limit rather than the protocol default', async () => {
    // An operation whose work includes a network round trip legitimately holds
    // the lock far longer than the render-and-rename the default was sized
    // for. The limit is per call so one such operation cannot fail every other
    // writer of the same file, and a caller that states a short one still
    // fails fast.
    const dir = await scratch()
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
    await expect(withFileLock(target, async () => 'impatient', { waitMs: 50 }))
      .rejects.toThrow(/timed out waiting for the writer lock/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)

    const patient = withFileLock(target, async () => 'patient', { waitMs: 10_000 })
    release()
    await holder
    expect(await patient).toBe('patient')
  })
})

describe('atomic write directory mode and lock lifecycle', () => {
  it('creates a missing parent directory with the requested mode', async () => {
    const root = await scratch()
    try {
      const target = join(root, 'nested', 'settings.json')
      await writeFileAtomic(target, '{}', { mode: 0o600, dirMode: 0o700 })

      expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700)
      expect(await readFile(target, 'utf8')).toBe('{}')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves the platform default in place when no directory mode is requested', async () => {
    const root = await scratch()
    try {
      const target = join(root, 'plain', 'settings.json')
      await writeFileAtomic(target, '{}', { mode: 0o600 })

      // 0o700 is what the explicit case asks for, so a default that equals it
      // would make the mode assertion above vacuous.
      expect((await stat(join(root, 'plain'))).mode & 0o777).not.toBe(0o700)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the holding process id into the lock file', async () => {
    const root = await scratch()
    try {
      const target = join(root, 'settings.json')
      const held = await withFileLock(target, async () => readFile(`${target}.lock`, 'utf8'))

      expect(held).toBe(`${process.pid}\n`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('releases cleanly when the operation removed the lock file itself', async () => {
    const root = await scratch()
    try {
      const target = join(root, 'settings.json')
      await expect(withFileLock(target, async () => {
        await rm(`${target}.lock`)
        return 'done'
      })).resolves.toBe('done')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('surfaces a non-contention lock failure even when the lock file exists', async () => {
    const root = await scratch()
    try {
      const target = join(root, 'settings.json')
      // An existing lock plus a code that is neither EEXIST nor EPERM is a real
      // failure, not contention: retrying it would hide the cause behind a
      // timeout.
      await writeFile(`${target}.lock`, 'held\n')
      state.lockCreateErrorCode = 'EACCES'
      await expect(withFileLock(target, async () => 'unreachable', { waitMs: 50 }))
        .rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('atomic write temp-file exclusivity and failure cleanup', () => {
  it('refuses to overwrite an existing temp file instead of clobbering it', async () => {
    const root = await scratch()
    try {
      const target = join(root, 'settings.json')
      state.fixedTempSuffix = 'aabbccddeeff'
      const temp = `${target}.aabbccddeeff.tmp`
      // A concurrent writer already owns this temp name. Exclusive creation is
      // what stops the second writer from renaming the first one's bytes over
      // the target.
      await writeFile(temp, 'other writer')

      await expect(writeFileAtomic(target, 'mine', { mode: 0o600 }))
        .rejects.toMatchObject({ code: 'EEXIST' })
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the write failure itself when no temp file was left behind', async () => {
    const root = await scratch()
    try {
      const target = join(root, 'settings.json')
      state.failTempWriteWithCode = 'ENOSPC'
      // Cleanup runs whether or not the temp exists, so the caller sees the
      // original failure rather than an ENOENT from the removal.
      await expect(writeFileAtomic(target, '{}', { mode: 0o600 }))
        .rejects.toMatchObject({ code: 'ENOSPC' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('writer lock deadline and backoff', () => {
  it('gives up the moment the wait reaches its deadline, not after it', async () => {
    const root = await scratch()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now')
    try {
      const target = join(root, 'settings.json')
      await writeFile(`${target}.lock`, 'held\n')
      // The deadline is computed from the first reading; every later reading
      // lands exactly on it. Waiting "until" the deadline must stop there —
      // treating equality as still-waiting never terminates.
      clock.mockReturnValueOnce(now).mockReturnValue(now + 50)

      await expect(withFileLock(target, async () => 'unreachable', { waitMs: 50 }))
        .rejects.toThrow(/timed out waiting for the writer lock/)
    } finally {
      clock.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('doubles the retry delay up to the cap while it waits', async () => {
    const root = await scratch()
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler, timeout?: number, ...rest: unknown[]
    ) => {
      delays.push(timeout ?? 0)
      // Run the retry immediately: the sequence under test is the delay
      // values, not the wall-clock time spent sleeping through them.
      return realSetTimeout(handler, 0, ...rest as [])
    }) as typeof globalThis.setTimeout)
    try {
      const target = join(root, 'settings.json')
      await writeFile(`${target}.lock`, 'held\n')

      await expect(withFileLock(target, async () => 'unreachable', { waitMs: 700 }))
        .rejects.toThrow(/timed out waiting for the writer lock/)
      expect(delays.slice(0, 5)).toEqual([20, 40, 80, 160, 200])
      expect(delays.every(delay => delay <= 200)).toBe(true)
    } finally {
      timer.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('writer lock non-Error throws', () => {
  it('surfaces a thrown null rather than reading a code off it', async () => {
    const root = await scratch()
    try {
      const target = join(root, 'settings.json')
      state.failLockCreateWithNull = true

      // The original value reaches the caller: reading `.code` off it would
      // replace the real failure with a TypeError from this package.
      await expect(withFileLock(target, async () => 'unreachable', { waitMs: 50 }))
        .rejects.toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
