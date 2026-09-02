import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  configureConnectionSecurity,
  configureDurability,
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
    const db = new FakeConnection(hardened())
    vi.spyOn(db, 'prepare').mockReturnValue({ get: () => undefined })
    expect(() =>{  configureConnectionSecurity(db, FILE_SUBJECT) })
      .toThrow('SQLite returned no row for PRAGMA trusted_schema')
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

  it('propagates a failure that is not a busy lock', async () => {
    for (const failure of [
      Object.assign(new Error('disk I/O error'), { errcode: 10 }),
      'not an error object',
      null,
    ]) {
      const db = new FakeConnection(hardened(), new Set(), () => {
        throw failure
      })
      await expect(selectJournalMode(db, FILE_SUBJECT, { ...selection, deadline: performance.now() + 1_000 }))
        .rejects.toBeDefined()
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
