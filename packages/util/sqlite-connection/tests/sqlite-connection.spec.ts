import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  configureConnectionSecurity,
  configureDurability,
  createDatabaseFile,
  prepareDatabasePath,
  readConnectionSettings,
  selectJournalMode,
  type SqliteConnection,
  type SqliteDatabaseSubject,
} from '../src/index.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sqlite-connection-'))
  dirs.push(dir)
  return join(dir, 'probe.db')
}

/** Pragma values a fake connection reports, before any statement is applied. */
type PragmaState = Record<string, number | string>

/**
 * A connection that answers pragma reads from its own state. `ignored`
 * statements are accepted and discarded, which is how a SQLite build that
 * silently declines a setting behaves.
 */
class FakeConnection implements SqliteConnection {
  readonly executed: string[] = []

  constructor(
    private readonly state: PragmaState,
    private readonly ignored: ReadonlySet<string> = new Set(),
    private readonly onSelect?: () => unknown,
  ) {}

  exec(sql: string): void {
    this.executed.push(sql)
    if (this.ignored.has(sql)) return
    const assignment = /^PRAGMA (?<name>\w+) = (?<value>\w+);$/u.exec(sql)
    if (assignment?.groups === undefined) throw new Error(`unexpected statement ${sql}`)
    const { name, value } = assignment.groups as { name: string; value: string }
    this.state[name] = value === 'OFF' ? 0 : value === 'FULL' ? 2 : Number(value)
  }

  prepare(sql: string): { get(): unknown } {
    return {
      get: () => {
        if (sql.includes('journal_mode')) {
          const selected = this.onSelect?.()
          return selected ?? { journal_mode: 'wal' }
        }
        const read = /^PRAGMA (?<name>\w+);$/u.exec(sql)
        if (read?.groups === undefined) throw new Error(`unexpected statement ${sql}`)
        const { name } = read.groups as { name: string }
        return { [name]: this.state[name] }
      },
    }
  }
}

function hardened(): PragmaState {
  return { trusted_schema: 1, mmap_size: 65_536, synchronous: 1 }
}

const FILE_SUBJECT: SqliteDatabaseSubject = { path: '/var/lib/dsh/probe.db', role: 'storage database' }
const MEMORY_SUBJECT: SqliteDatabaseSubject = { path: ':memory:', role: 'storage database' }

function busy(): Error {
  return Object.assign(new Error('database is locked'), { errcode: 5 })
}

describe('SQLite connection settings against a real driver', () => {
  it('holds schema trust off, mapping off, and synchronous FULL on a file-backed connection', async () => {
    const path = await freshDbPath()
    const db = new DatabaseSync(path, { timeout: 1_000 })
    const subject: SqliteDatabaseSubject = { path, role: 'storage database' }
    try {
      configureConnectionSecurity(db, subject)
      await selectJournalMode(db, subject, {
        statement: 'PRAGMA journal_mode = WAL',
        mode: 'wal',
        deadline: performance.now() + 1_000,
      })
      configureDurability(db, subject)
      expect(readConnectionSettings(db)).toEqual({ trustedSchema: 0, mmapSize: 0, synchronous: 2 })
    } finally {
      db.close()
    }
  })

  it('accepts the memory journal mode an in-process connection reports', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      configureConnectionSecurity(db, MEMORY_SUBJECT)
      await selectJournalMode(db, MEMORY_SUBJECT, {
        statement: 'PRAGMA journal_mode = WAL',
        mode: 'wal',
        deadline: performance.now() + 1_000,
      })
      configureDurability(db, MEMORY_SUBJECT)
      // An in-process connection reports no mmap_size row at all, which is why
      // the security step skips that read-back for `:memory:`.
      expect(db.prepare('PRAGMA mmap_size').get()).toBeUndefined()
      expect(db.prepare('PRAGMA trusted_schema').get()).toEqual({ trusted_schema: 0 })
      expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
    } finally {
      db.close()
    }
  })
})

describe('configureConnectionSecurity', () => {
  it('applies both settings and verifies them', () => {
    const db = new FakeConnection(hardened())
    configureConnectionSecurity(db, FILE_SUBJECT)
    expect(db.executed).toEqual(['PRAGMA trusted_schema = OFF;', 'PRAGMA mmap_size = 0;'])
    expect(readConnectionSettings(db)).toEqual({ trustedSchema: 0, mmapSize: 0, synchronous: 1 })
  })

  it('fails loud when the connection keeps trusting the schema', () => {
    const db = new FakeConnection(hardened(), new Set(['PRAGMA trusted_schema = OFF;']))
    expect(() =>{  configureConnectionSecurity(db, FILE_SUBJECT) })
      .toThrow('storage database at "/var/lib/dsh/probe.db" retained trusted_schema=1, expected 0')
  })

  it('fails loud when the connection keeps a memory mapping', () => {
    const db = new FakeConnection(hardened(), new Set(['PRAGMA mmap_size = 0;']))
    expect(() =>{  configureConnectionSecurity(db, FILE_SUBJECT) })
      .toThrow('storage database at "/var/lib/dsh/probe.db" retained mmap_size=65536, expected 0')
  })

  it('skips the mapping read-back for an in-process database', () => {
    const db = new FakeConnection(hardened(), new Set(['PRAGMA mmap_size = 0;']))
    expect(() =>{  configureConnectionSecurity(db, MEMORY_SUBJECT) }).not.toThrow()
  })

  it('rejects a driver that answers a pragma read with no row', () => {
    // `null` and `undefined` are separate answers: `typeof null` is 'object',
    // so only the explicit null check rejects a driver that answers with it.
    for (const answer of [undefined, null]) {
      const db = new FakeConnection(hardened())
      vi.spyOn(db, 'prepare').mockReturnValue({ get: () => answer })
      expect(() => { configureConnectionSecurity(db, FILE_SUBJECT) })
        .toThrow('SQLite returned no row for PRAGMA trusted_schema')
    }
  })

  it('rejects a driver that answers a pragma read with a non-integer', () => {
    const db = new FakeConnection(
      { ...hardened(), trusted_schema: 'off' },
      new Set(['PRAGMA trusted_schema = OFF;']),
    )
    expect(() =>{  configureConnectionSecurity(db, FILE_SUBJECT) })
      .toThrow('SQLite returned a non-integer PRAGMA trusted_schema')
  })
})

describe('configureDurability', () => {
  it('pins synchronous FULL and verifies it', () => {
    const db = new FakeConnection(hardened())
    configureDurability(db, FILE_SUBJECT)
    expect(db.executed).toEqual(['PRAGMA synchronous = FULL;'])
    expect(readConnectionSettings(db).synchronous).toBe(2)
  })

  it('fails loud when the connection keeps a weaker synchronous level', () => {
    const db = new FakeConnection(hardened(), new Set(['PRAGMA synchronous = FULL;']))
    expect(() =>{  configureDurability(db, FILE_SUBJECT) })
      .toThrow('storage database at "/var/lib/dsh/probe.db" retained synchronous=1, expected FULL (2)')
  })
})

describe('selectJournalMode', () => {
  const selection = { statement: 'PRAGMA journal_mode = WAL;', mode: 'wal' }

  it('retries a busy transition until it succeeds', async () => {
    let attempts = 0
    const db = new FakeConnection(hardened(), new Set(), () => {
      attempts += 1
      if (attempts < 3) throw busy()
      return { journal_mode: 'WAL' }
    })
    await selectJournalMode(db, FILE_SUBJECT, { ...selection, deadline: performance.now() + 1_000 })
    expect(attempts).toBe(3)
  })

  it('propagates a busy failure once the deadline has passed', async () => {
    let attempts = 0
    const db = new FakeConnection(hardened(), new Set(), () => {
      attempts += 1
      throw busy()
    })
    await expect(selectJournalMode(db, FILE_SUBJECT, { ...selection, deadline: performance.now() - 1 }))
      .rejects.toThrow('database is locked')
    expect(attempts).toBe(1)
  })

  it('stops retrying when the deadline passes during the pause', async () => {
    let attempts = 0
    const db = new FakeConnection(hardened(), new Set(), () => {
      attempts += 1
      throw busy()
    })
    const clock = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(100)
    try {
      await expect(selectJournalMode(db, FILE_SUBJECT, { ...selection, deadline: 100 }))
        .rejects.toThrow('database is locked')
    } finally {
      clock.mockRestore()
    }
    expect(attempts).toBe(1)
  })

  it('propagates a failure that is not a busy lock, unchanged and on the first attempt', async () => {
    // The exact value has to reach the caller: a driver error replaced by a
    // TypeError from reading `errcode` off a primitive says nothing about the
    // database. One attempt proves the retry arm was not taken.
    for (const failure of [
      Object.assign(new Error('disk I/O error'), { errcode: 10 }),
      Object.assign(new Error('constraint'), { errcode: 19 }),
      'not an error object',
      null,
      undefined,
    ]) {
      let attempts = 0
      const db = new FakeConnection(hardened(), new Set(), () => {
        attempts += 1
        throw failure
      })
      await expect(selectJournalMode(db, FILE_SUBJECT, { ...selection, deadline: performance.now() + 1_000 }))
        .rejects.toBe(failure)
      expect(attempts, `${String(failure)} must not be retried`).toBe(1)
    }
  })

  it('gives up on a spent deadline without pausing first', async () => {
    // Only setTimeout is faked, so nothing advances it: a pause would never
    // resolve, and the rejection proves the remaining budget read as zero
    // before any pause was scheduled.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      let attempts = 0
      const db = new FakeConnection(hardened(), new Set(), () => {
        attempts += 1
        throw busy()
      })
      await expect(selectJournalMode(db, FILE_SUBJECT, { ...selection, deadline: performance.now() - 1 }))
        .rejects.toThrow('database is locked')
      expect(attempts).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails loud when the connection reports another journal mode', async () => {
    const db = new FakeConnection(hardened(), new Set(), () => ({ journal_mode: 'delete' }))
    await expect(selectJournalMode(db, FILE_SUBJECT, { ...selection, deadline: performance.now() + 1_000 }))
      .rejects.toThrow('storage database at "/var/lib/dsh/probe.db" selected journal mode delete, expected wal')
  })

  it('rejects a driver that answers the transition with a non-text mode', async () => {
    const db = new FakeConnection(hardened(), new Set(), () => ({ journal_mode: 7 }))
    await expect(selectJournalMode(db, FILE_SUBJECT, { ...selection, deadline: performance.now() + 1_000 }))
      .rejects.toThrow('SQLite returned a non-text PRAGMA journal_mode')
  })
})

describe('createDatabaseFile', () => {
  it('creates a missing file the owner alone can read', async () => {
    const path = await freshDbPath()
    await createDatabaseFile(path)

    const created = await stat(path)
    expect(created.isFile()).toBe(true)
    expect(created.size).toBe(0)
    if (process.platform !== 'win32') expect(created.mode & 0o777).toBe(0o600)
  })

  it('leaves the bytes and mode of an existing file alone', async () => {
    const path = await freshDbPath()
    await writeFile(path, 'existing', { mode: 0o640 })
    await createDatabaseFile(path)

    expect(await readFile(path, 'utf8')).toBe('existing')
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o640)
  })

  it('propagates a failure that is not an existing file', async () => {
    // The parent is missing, so the open fails ENOENT. Swallowing everything
    // would report a database that was never created.
    const path = join(await freshDbPath(), 'missing-parent', 'probe.db')
    await expect(createDatabaseFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('prepareDatabasePath', () => {
  it('passes :memory: through without touching the filesystem', async () => {
    const before = await mkdtemp(join(tmpdir(), 'dsh-sqlite-memory-'))
    dirs.push(before)
    expect(await prepareDatabasePath(':memory:')).toBe(':memory:')
    await expect(stat(join(before, ':memory:'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns an absolute path and creates the file it names', async () => {
    const path = await freshDbPath()
    const prepared = await prepareDatabasePath(path)

    expect(prepared).toBe(path)
    expect(isAbsolute(prepared)).toBe(true)
    expect((await stat(prepared)).isFile()).toBe(true)
  })

  it('creates a parent directory that does not exist yet, owner-only', async () => {
    // `recursive` is what makes a nested parent work, and it is also what keeps
    // an existing parent from failing EEXIST; both cases are here.
    const root = await mkdtemp(join(tmpdir(), 'dsh-sqlite-nested-'))
    dirs.push(root)
    const nested = join(root, 'a', 'b', 'probe.db')
    await prepareDatabasePath(nested)

    expect((await stat(nested)).isFile()).toBe(true)
    if (process.platform !== 'win32') expect((await stat(dirname(nested))).mode & 0o777).toBe(0o700)
  })

  it('accepts a parent directory that already exists', async () => {
    const path = await freshDbPath()
    await prepareDatabasePath(path)
    await expect(prepareDatabasePath(path)).resolves.toBe(path)
  })
})
