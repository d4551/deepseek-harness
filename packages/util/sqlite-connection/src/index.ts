/**
 * The open-time steps every Harness SQLite database takes: the owner-only file
 * creation each backend performs before connecting, and the connection settings
 * it then holds — schema trust and memory mapping off, commits fully
 * synchronized, and a journal-mode transition that waits out a competing writer.
 * Each setting is applied and then read back, so a SQLite build that ignores a
 * pragma fails the open instead of serving an unhardened connection. Statements
 * are fixed constants here; callers never supply pragma text for these settings.
 * @module @deepseek-ai/dsh-sqlite-connection
 */

import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

/** Default wait for another connection's write reservation. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000

/** Largest busy timeout accepted by SQLite's signed millisecond interface. */
export const MAX_BUSY_TIMEOUT_MS = 2_147_483_647

/** Pause between attempts at a journal-mode transition a competing writer holds off. */
const JOURNAL_BUSY_RETRY_INTERVAL_MS = 10

/** SQLite's `SQLITE_BUSY` result code, reported on `errcode`. */
const SQLITE_BUSY = 5

/** `synchronous=FULL` as SQLite reports it back. */
const SYNCHRONOUS_FULL_LEVEL = 2

const TRUSTED_SCHEMA_OFF = 'PRAGMA trusted_schema = OFF;'
const SELECT_TRUSTED_SCHEMA = 'PRAGMA trusted_schema;'
const MMAP_OFF = 'PRAGMA mmap_size = 0;'
const SELECT_MMAP_SIZE = 'PRAGMA mmap_size;'
const SYNCHRONOUS_FULL = 'PRAGMA synchronous = FULL;'
const SELECT_SYNCHRONOUS = 'PRAGMA synchronous;'

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 * `DatabaseSync` reopens by path, so this does not protect confidentiality or
 * integrity when another principal can replace the database entry in its
 * parent directory.
 * @param path - the database file to create when absent.
 * @returns settlement once the file exists.
 */
export async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Resolve one database path and give it an owner-only parent directory and
 * file before any connection opens. `:memory:` names no filesystem entry and
 * passes through untouched.
 * @param path - the configured database path, or `:memory:`.
 * @returns the absolute path to open, or `:memory:` unchanged.
 */
export async function prepareDatabasePath(path: string): Promise<string> {
  if (path === ':memory:') return path
  const actual = resolve(path)
  await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
  await createDatabaseFile(actual)
  return actual
}

/** The prepared-statement surface these helpers use. */
export interface SqliteStatement {
  /**
   * Run the statement and return its first row.
   * @returns the row SQLite produced, unvalidated.
   */
  get(): unknown
}

/** The `node:sqlite` connection surface these helpers use; `DatabaseSync` satisfies it. */
export interface SqliteConnection {
  /**
   * Execute one statement for its effect.
   * @param sql - statement text.
   */
  exec(sql: string): void
  /**
   * Prepare one statement.
   * @param sql - statement text.
   * @returns the prepared statement.
   */
  prepare(sql: string): SqliteStatement
}

/** The database a helper is configuring, as its failure messages name it. */
export interface SqliteDatabaseSubject {
  /** SQLite path, or `:memory:`, whose connection reports memory journaling and no mapping. */
  readonly path: string
  /** Noun naming this database in failure messages, such as `session database`. */
  readonly role: string
}

/** Connection settings as the live connection reports them. */
export interface SqliteConnectionSettings {
  /** `0` once schema trust is off; a non-zero value leaves views, triggers, and index expressions trusted. */
  readonly trustedSchema: number
  /** `0` once memory mapping is off; file-backed connections must report it. */
  readonly mmapSize: number
  /** `2` for `FULL`; lower levels let a committed write vanish in an OS crash or power loss. */
  readonly synchronous: number
}

/** One journal-mode transition and the wait it may spend on a competing writer. */
export interface JournalSelection {
  /** Statement that selects the mode and returns the resulting `journal_mode` row. */
  readonly statement: string
  /** Mode the caller asked for; a `:memory:` connection reports `memory` instead. */
  readonly mode: string
  /** `performance.now()` value after which a busy transition stops retrying. */
  readonly deadline: number
}

/**
 * Read the connection settings back from a live file-backed connection. An
 * in-process (`:memory:`) connection answers `PRAGMA mmap_size` with no row,
 * so this rejects for one.
 * @param db - open connection.
 * @returns the settings SQLite reports for this connection.
 * @throws when SQLite reports no row or a non-integer setting.
 */
export function readConnectionSettings(db: SqliteConnection): SqliteConnectionSettings {
  return {
    trustedSchema: readTrustedSchema(db),
    mmapSize: readMmapSize(db),
    synchronous: readSynchronous(db),
  }
}

/**
 * Turn off schema trust and memory mapping, then verify both took effect.
 * Apply this before any statement that can reach a view, trigger, or index
 * expression: with schema trust on, a database file another principal can
 * write runs functions from those objects on open.
 * @param db - connection to secure.
 * @param database - database being secured, for failure messages.
 * @throws when the connection retains schema trust or a memory mapping.
 */
export function configureConnectionSecurity(db: SqliteConnection, database: SqliteDatabaseSubject): void {
  db.exec(TRUSTED_SCHEMA_OFF)
  const trustedSchema = readTrustedSchema(db)
  if (trustedSchema !== 0) {
    throw new Error(`${database.role} at "${database.path}" retained trusted_schema=${trustedSchema}, expected 0`)
  }
  db.exec(MMAP_OFF)
  if (database.path === ':memory:') return
  const mmapSize = readMmapSize(db)
  if (mmapSize !== 0) {
    throw new Error(`${database.role} at "${database.path}" retained mmap_size=${mmapSize}, expected 0`)
  }
}

/**
 * Pin `synchronous=FULL` and verify it took effect, so a committed write
 * survives an OS crash or power loss.
 * @param db - connection to make durable.
 * @param database - database being configured, for failure messages.
 * @throws when the connection retains a weaker synchronous level.
 */
export function configureDurability(db: SqliteConnection, database: SqliteDatabaseSubject): void {
  db.exec(SYNCHRONOUS_FULL)
  const synchronous = readSynchronous(db)
  if (synchronous !== SYNCHRONOUS_FULL_LEVEL) {
    throw new Error(
      `${database.role} at "${database.path}" retained synchronous=${synchronous}, expected FULL (${SYNCHRONOUS_FULL_LEVEL})`,
    )
  }
}

/**
 * Select the journal mode and verify the mode SQLite reports back. A busy
 * competitor retries until the selection's deadline, because SQLite answers
 * the exclusive transition with `SQLITE_BUSY` instead of waiting on the
 * connection's busy timeout.
 * @param db - connection whose journal mode is being selected.
 * @param database - database being configured, for failure messages.
 * @param selection - transition statement, requested mode, and busy deadline.
 * @returns settlement once the connection runs in the requested mode.
 * @throws when the transition keeps failing or the connection reports another mode.
 */
export async function selectJournalMode(
  db: SqliteConnection,
  database: SqliteDatabaseSubject,
  selection: JournalSelection,
): Promise<void> {
  let result: unknown
  while (true) {
    try {
      result = db.prepare(selection.statement).get()
      break
    } catch (error: unknown) {
      const remainingMs = Math.max(0, Math.ceil(selection.deadline - performance.now()))
      if (!isSqliteBusy(error) || remainingMs === 0) throw error
      await delay(Math.min(JOURNAL_BUSY_RETRY_INTERVAL_MS, remainingMs))
      if (performance.now() >= selection.deadline) throw error
    }
  }
  const selected = pragmaText(result, 'journal_mode').toLowerCase()
  const expected = database.path === ':memory:' ? 'memory' : selection.mode
  if (selected !== expected) {
    throw new Error(`${database.role} at "${database.path}" selected journal mode ${selected}, expected ${expected}`)
  }
}

function readTrustedSchema(db: SqliteConnection): number {
  return pragmaInteger(db.prepare(SELECT_TRUSTED_SCHEMA).get(), 'trusted_schema')
}

function readMmapSize(db: SqliteConnection): number {
  return pragmaInteger(db.prepare(SELECT_MMAP_SIZE).get(), 'mmap_size')
}

function readSynchronous(db: SqliteConnection): number {
  return pragmaInteger(db.prepare(SELECT_SYNCHRONOUS).get(), 'synchronous')
}

function pragmaField(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null) throw new Error(`SQLite returned no row for PRAGMA ${key}`)
  return Reflect.get(row, key)
}

function pragmaInteger(row: unknown, key: string): number {
  const value = pragmaField(row, key)
  if (!Number.isSafeInteger(value)) throw new Error(`SQLite returned a non-integer PRAGMA ${key}`)
  return value as number
}

function pragmaText(row: unknown, key: string): string {
  const value = pragmaField(row, key)
  if (typeof value !== 'string') throw new Error(`SQLite returned a non-text PRAGMA ${key}`)
  return value
}

function isSqliteBusy(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'errcode') === SQLITE_BUSY
}
