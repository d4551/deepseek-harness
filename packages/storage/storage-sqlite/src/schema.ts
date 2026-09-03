/**
 * Schema + open-time helpers for the SQLite storage backend: the physical
 * layout version, the database open/configure sequence (permissions, pragmas,
 * version stamp/reject), and the unit metadata tables. Unit record tables are
 * created per descriptor in `unit.ts`.
 * @module @deepseek-ai/dsh-storage-sqlite/schema
 */

import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import {
  configureConnectionSecurity,
  configureDurability,
  prepareDatabasePath,
  selectJournalMode,
  type SqliteDatabaseSubject,
} from '@deepseek-ai/dsh-sqlite-connection'
import { StorageError } from '@deepseek-ai/dsh-storage'

/**
 * The on-disk physical layout version, stored in `PRAGMA user_version`.
 * Orthogonal to each unit's own `version` (stamped per unit in the `units`
 * row). Bumped only on a breaking change to the table layout; any other
 * stamped version rejects — this unreleased format has no migrations.
 */
export const STORAGE_SQLITE_SCHEMA_VERSION = 1

/**
 * Journal modes the backend will run under. `wal` is the default; the
 * rollback-journal modes (`delete`/`truncate`/`persist`) exist for
 * filesystems where WAL's shared-memory files do not work (network mounts).
 * `memory`/`off` are excluded: dropping journal durability silently
 * contradicts the durability clause of the KV backend contract.
 */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

/** How this backend names its database in connection failure messages. */
const DATABASE_ROLE = 'storage database'

/**
 * Open the database and apply its schema, connection settings, and pragmas.
 * Missing directories and database files are created owner-only (`:memory:`
 * skips filesystem setup). Schema trust, memory mapping, the journal mode,
 * and `synchronous=FULL` come from `@deepseek-ai/dsh-sqlite-connection`, which
 * reads each one back, so a connection that keeps an unsafe setting fails the
 * open. A zero `user_version` is stamped with
 * {@link STORAGE_SQLITE_SCHEMA_VERSION}; every other non-current version
 * rejects rather than being migrated in place.
 * @param path - the SQLite database file to open, or `:memory:`.
 * @param journalMode - validated journal pragma.
 * @param busyTimeoutMs - validated maximum wait for a competing SQLite lock.
 * @returns the open handle with pragmas applied and the unit metadata tables ensured.
 */
export async function openDatabase(
  path: string,
  journalMode: JournalMode,
  busyTimeoutMs: number,
): Promise<DatabaseSync> {
  const actual = await prepareDatabasePath(path)
  const deadline = performance.now() + busyTimeoutMs
  const database: SqliteDatabaseSubject = { path: actual, role: DATABASE_ROLE }
  const db = new DatabaseSync(actual, { timeout: busyTimeoutMs })
  try {
    configureConnectionSecurity(db, database)
    configureDatabase(db, actual)
    await selectJournalMode(db, database, {
      // The validated union is safe to interpolate into a non-bindable PRAGMA.
      statement: `PRAGMA journal_mode = ${journalMode.toUpperCase()}`,
      mode: journalMode,
      deadline,
    })
    configureDurability(db, database)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string): void {
  db.exec('PRAGMA foreign_keys = ON')
  // `PRAGMA user_version` always returns exactly one row { user_version }.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== STORAGE_SQLITE_SCHEMA_VERSION) {
    throw new StorageError(
      'version-mismatch',
      `storage database at "${path}" has schema version ${onDisk}, incompatible with this build (${STORAGE_SQLITE_SCHEMA_VERSION})`,
    )
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_globals (
      unit  TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT
  `)
  if (onDisk === 0) {
    // Stamp fresh databases LAST: the stamp asserts the layout is complete,
    // so a failure above must leave the medium unstamped (a re-open after
    // the obstruction is cleared retries materialization from scratch).
    db.exec(`PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION}`)
  }
}

/**
 * Physical table name for one unit table. Both segments are validated against
 * `UNIT_NAME_RE` before reaching this, so the result is safe to interpolate
 * into DDL and prepared-statement text.
 * @param unit - Validated unit name.
 * @param table - Validated table name.
 * @returns the `u_<unit>_<table>` identifier.
 */
export function recordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}
