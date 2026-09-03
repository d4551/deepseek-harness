import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  MAX_BUSY_TIMEOUT_MS,
  readConnectionSettings,
} from '@deepseek-ai/dsh-sqlite-connection'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { runKvBackendContract } from '../../storage/tests/contract.ts'
import * as StorageSqlite from '../src/index.ts'
import { Config, SqliteStorageBackend, STORAGE_SQLITE_SCHEMA_VERSION } from '../src/index.ts'
import { openDatabase } from '../src/schema.ts'

/** Mirror the loader: resolve schemastery defaults before construction. */
function backendAt(path: string): SqliteStorageBackend {
  return new SqliteStorageBackend(new Config({ path }))
}

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function freshDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-'))
  dirs.push(dir)
  return join(dir, 'storage.db')
}

// The contract suite's reopen() needs a surviving medium, so the harness binds
// a real file; :memory: gets its own cases below.
runKvBackendContract('sqlite', async () => {
  const path = await freshDbPath()
  return {
    backend: backendAt(path),
    reopen: async () => backendAt(path),
  }
})

const DESCRIPTOR: KvUnitDescriptor = {
  name: 'specimen',
  version: 1,
  tables: ['records'],
  hasGlobal: true,
}

describe('sqlite backend specifics', () => {
  it('opens an in-memory database', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    expect((await unit.loadAll()).tables['records']).toEqual({ k: { n: 1 } })
    await backend.close()
  })

  it('materializes STRICT record tables and stamps the schema version', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    try {
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
      expect(version).toBe(STORAGE_SQLITE_SCHEMA_VERSION)
      const table = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'u_specimen_records'",
      ).get() as { sql: string } | undefined
      expect(table?.sql).toContain('STRICT')
      const unitRow = db.prepare('SELECT version FROM units WHERE name = ?').get('specimen') as { version: number }
      expect(unitRow.version).toBe(DESCRIPTOR.version)
    } finally {
      db.close()
    }
  })

  it('rejects a mismatched database schema version', async () => {
    const path = await freshDbPath()
    const db = new DatabaseSync(path)
    db.exec('PRAGMA user_version = 999')
    db.close()

    const backend = backendAt(path)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({
      name: 'StorageError',
      code: 'version-mismatch',
    })
    await backend.close()
  })

  it('rejects invalid unit and table names before touching the medium', async () => {
    const backend = backendAt(':memory:')
    await expect(backend.kv.open({ ...DESCRIPTOR, name: 'Bad-Name' })).rejects.toThrow(/violates/)
    await expect(backend.kv.open({ ...DESCRIPTOR, tables: ['ok', '1bad'] })).rejects.toThrow(/violates/)
    await backend.close()
  })

  it('rejects a second open of the same unit name', async () => {
    const backend = backendAt(':memory:')
    await backend.kv.open(DESCRIPTOR)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/already open/)
    await backend.close()
  })

  it('allows re-open after unit close, and rejects open on a closed backend', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.close()
    const again = await backend.kv.open(DESCRIPTOR)
    await again.putRecord('records', 'k', 1)
    await backend.close()
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
  })

  it('round-trips prototype-polluting keys as own properties', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', '__proto__', { evil: true })
    await unit.putRecord('records', 'constructor', { n: 1 })
    const { tables } = await unit.loadAll()
    const records = tables['records']!
    expect(Object.hasOwn(records, '__proto__')).toBe(true)
    expect(records['__proto__']).toEqual({ evil: true })
    expect(records['constructor']).toEqual({ n: 1 })
    expect(Object.getPrototypeOf({})).not.toHaveProperty('evil')
    await backend.close()
  })

  it('leaves a failed materialization unstamped so a repaired medium reopens', async () => {
    const path = await freshDbPath()
    // Obstruct table creation: an index squatting on the unit_globals name
    // makes CREATE TABLE IF NOT EXISTS throw AFTER the units table exists.
    const setup = new DatabaseSync(path)
    setup.exec('CREATE TABLE squatter (x TEXT)')
    setup.exec('CREATE INDEX unit_globals ON squatter(x)')
    setup.close()

    const broken = backendAt(path)
    await expect(broken.kv.open(DESCRIPTOR)).rejects.toThrow(/already an index/)
    await broken.close()

    // Clear the obstruction; the medium must still be version 0, not a
    // half-materialized database stamped as current.
    const repair = new DatabaseSync(path)
    expect((repair.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
    repair.exec('DROP INDEX unit_globals')
    repair.close()

    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })
    await backend.close()
  })

  it('rejects unparsable stored JSON with malformed-medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'good', { n: 1 })
    await unit.setGlobal({ g: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare('UPDATE u_specimen_records SET value = ? WHERE key = ?').run('{not json', 'good')
    db.close()

    const reopened = backendAt(path)
    const damaged = await reopened.kv.open(DESCRIPTOR)
    await expect(damaged.loadAll()).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await reopened.close()
  })

  it('wraps a non-Error toJSON throw into an Error rejection', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open(DESCRIPTOR)
    // JSON.stringify propagates a value's own toJSON throw verbatim; the unit
    // must still reject with an Error instance.
    const hostile = { toJSON: () => { throw 'not an error' } }
    await expect(unit.putRecord('records', 'k', hostile)).rejects.toThrow('not an error')
    await expect(unit.putRecord('records', 'k', hostile)).rejects.toBeInstanceOf(Error)
    await backend.close()
  })

  it('rejects setGlobal on a unit without a global slot and writes to undeclared tables', async () => {
    const backend = backendAt(':memory:')
    const unit = await backend.kv.open({ ...DESCRIPTOR, hasGlobal: false })
    await expect(unit.setGlobal({ g: 1 })).rejects.toThrow(/declared no global slot/)
    await expect(unit.putRecord('undeclared', 'k', 1)).rejects.toThrow(/declared no table/)
    expect((await unit.loadAll()).global).toBeNull()
    await backend.close()
  })

  it('drains a still-pending failed open during close', async () => {
    const path = await freshDbPath()
    const first = backendAt(path)
    await (await first.kv.open(DESCRIPTOR)).close()
    await first.close()

    const backend = backendAt(path)
    // Do not await: close() must tolerate an in-flight open that will reject
    // (version mismatch) while its name is still reserved in the unit table.
    const pending = backend.kv.open({ ...DESCRIPTOR, version: 99 })
    const closed = backend.close()
    await expect(pending).rejects.toMatchObject({ code: 'version-mismatch' })
    await closed
  })

  it('propagates filesystem errors other than an existing database file', async () => {
    if (process.platform === 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'dsh-storage-sqlite-'))
    dirs.push(dir)
    await chmod(dir, 0o500)
    const backend = backendAt(join(dir, 'storage.db'))
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'EACCES' })
    await backend.close()
    await chmod(dir, 0o700)
  })

  it('propagates an invalid database filename before opening SQLite', async () => {
    const path = await freshDbPath()
    const backend = backendAt(`${path}\0invalid`)
    await expect(backend.kv.open(DESCRIPTOR)).rejects.toThrow(/null bytes/i)
    await backend.close()
  })

  it('preserves the mode of an existing database file', async () => {
    if (process.platform === 'win32') return
    const path = await freshDbPath()
    await writeFile(path, '', { mode: 0o644 })
    await chmod(path, 0o644)
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', 1)
    await backend.close()
    // The write reached the pre-existing file and left its mode untouched.
    expect((await stat(path)).mode & 0o777).toBe(0o644)
  })

  it('registers on the storage hub as backend sqlite and closes on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const fiber = await ctx.plugin(StorageSqlite, { path: ':memory:' })
    const backend = ctx.storage.backend.get('sqlite')
    expect(ctx.get(storageBackendServiceKey('sqlite'))).toBe(backend)
    const unit = await backend.kv!.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })

    await fiber.dispose()
    expect(ctx.storage.backend.names()).toEqual([])
    expect(ctx.get(storageBackendServiceKey('sqlite'))).toBeUndefined()
    await expect(backend.kv!.open(DESCRIPTOR)).rejects.toMatchObject({ code: 'closed' })
  })

  it('holds the connection settings the shared owner verifies', async () => {
    const db = await openDatabase(await freshDbPath(), 'wal', DEFAULT_BUSY_TIMEOUT_MS)
    try {
      expect(readConnectionSettings(db)).toEqual({ trustedSchema: 0, mmapSize: 0, synchronous: 2 })
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    } finally {
      db.close()
    }
  })

  it('holds every configured journal mode and the in-process reported mode', async () => {
    for (const mode of ['wal', 'delete', 'truncate', 'persist'] as const) {
      const db = await openDatabase(await freshDbPath(), mode, DEFAULT_BUSY_TIMEOUT_MS)
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: mode })
      expect(readConnectionSettings(db)).toEqual({ trustedSchema: 0, mmapSize: 0, synchronous: 2 })
      db.close()

      const memory = await openDatabase(':memory:', mode, DEFAULT_BUSY_TIMEOUT_MS)
      expect(memory.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'memory' })
      expect(memory.prepare('PRAGMA trusted_schema').get()).toEqual({ trusted_schema: 0 })
      expect(memory.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 })
      memory.close()
    }
  })

  it('closes the connection and fails loud when a setting cannot be applied', async () => {
    vi.resetModules()
    let opened: DatabaseSync | undefined
    vi.doMock('@deepseek-ai/dsh-sqlite-connection', async importOriginal => ({
      ...await importOriginal<typeof import('@deepseek-ai/dsh-sqlite-connection')>(),
      // A SQLite build that accepts `PRAGMA trusted_schema = OFF` and keeps
      // trusting the schema reaches exactly this rejection.
      configureConnectionSecurity: (db: DatabaseSync) => {
        opened = db
        throw new Error('storage database retained trusted_schema=1, expected 0')
      },
    }))
    try {
      const { openDatabase: guarded } = await import('../src/schema.ts')
      await expect(guarded(await freshDbPath(), 'wal', DEFAULT_BUSY_TIMEOUT_MS))
        .rejects.toThrow(/retained trusted_schema=1/)
      expect(opened).toBeDefined()
      expect(() => opened?.prepare('PRAGMA user_version').get()).toThrow(/not open/i)
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-sqlite-connection')
      vi.resetModules()
    }
  })

  it('opens a database materialized before the connection settings were verified', async () => {
    const path = await freshDbPath()
    // The pre-hardening open sequence: journal mode and foreign keys only.
    const legacy = new DatabaseSync(path)
    legacy.exec('PRAGMA foreign_keys = ON')
    legacy.exec('PRAGMA journal_mode = WAL')
    legacy.exec('CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT')
    legacy.exec('CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT')
    legacy.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run('specimen', 1)
    legacy.exec('CREATE TABLE u_specimen_records (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    legacy.prepare('INSERT INTO u_specimen_records (key, value) VALUES (?, ?)').run('k', '{"n":1}')
    legacy.exec(`PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION}`)
    legacy.close()

    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    expect((await unit.loadAll()).tables['records']).toEqual({ k: { n: 1 } })
    await backend.close()
  })

  it('validates busyTimeoutMs against SQLite bounds', () => {
    expect(new Config({ path: ':memory:' }).busyTimeoutMs).toBe(DEFAULT_BUSY_TIMEOUT_MS)
    expect(new Config({ path: ':memory:', busyTimeoutMs: 0 }).busyTimeoutMs).toBe(0)
    expect(new Config({ path: ':memory:', busyTimeoutMs: MAX_BUSY_TIMEOUT_MS }).busyTimeoutMs)
      .toBe(MAX_BUSY_TIMEOUT_MS)
    expect(() => new Config({ path: ':memory:', busyTimeoutMs: -1 })).toThrow()
    expect(() => new Config({ path: ':memory:', busyTimeoutMs: 1.5 })).toThrow()
    expect(() => new Config({ path: ':memory:', busyTimeoutMs: MAX_BUSY_TIMEOUT_MS + 1 })).toThrow()
  })

  it('waits for a competing process within the configured busy timeout', async () => {
    const path = await freshDbPath()
    const backend = new SqliteStorageBackend(new Config({ path, journalMode: 'wal', busyTimeoutMs: 5_000 }))
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.putRecord('records', 'k', { n: 1 })

    // A same-thread holder would deadlock: the synchronous driver blocks the
    // event loop that would release the lock, so the competitor is a process.
    const holder = spawn(process.execPath, ['--input-type=module', '-e', String.raw`
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 100);
    `, path], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise<number | null>((settle, fail) => {
      holder.once('error', fail)
      holder.once('exit', settle)
    })
    try {
      await once(holder.stdout, 'data')
      await expect(unit.putRecord('records', 'k', { n: 2 })).resolves.toBeUndefined()
      expect(await exited).toBe(0)
      expect((await unit.loadAll()).tables['records']).toEqual({ k: { n: 2 } })
    } finally {
      if (holder.exitCode === null) holder.kill()
      await backend.close()
    }
  })

  it('rejects an unparsable global slot with malformed-medium', async () => {
    const path = await freshDbPath()
    const backend = backendAt(path)
    const unit = await backend.kv.open(DESCRIPTOR)
    await unit.setGlobal({ g: 1 })
    await backend.close()

    const db = new DatabaseSync(path)
    db.prepare('UPDATE unit_globals SET value = ? WHERE unit = ?').run('][', 'specimen')
    db.close()

    const reopened = backendAt(path)
    const damaged = await reopened.kv.open(DESCRIPTOR)
    await expect(damaged.loadAll()).rejects.toMatchObject({
      name: 'StorageError',
      code: 'malformed-medium',
    })
    await reopened.close()
  })
})
