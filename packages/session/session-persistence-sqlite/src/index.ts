/**
 * Opt-in SQLite persistence provider. Logical sessions remain unchanged;
 * the physical backend packs eligible chunk runs into schema-19 rows.
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BUSY_TIMEOUT_MS, MAX_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-sqlite-connection'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  type SessionLocation,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { CoordinatedSessionPersistence } from '@deepseek-ai/dsh-session-persistence/coordinated'
import type { JournalMode } from './schema.ts'
import { SqliteStore } from './store.ts'

export { SCHEMA_VERSION } from './schema.ts'

/** Plugin configuration. */
export interface Config {
  /** SQLite database path, or `:memory:` for an in-process database. */
  path: string
  /** Durable SQLite journal mode; defaults to `wal`. */
  journalMode?: JournalMode
  /** Maximum wait for another SQLite connection's lock; defaults to 5,000 ms. */
  busyTimeoutMs?: number
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/**
 * SQLite `SessionPersistence` provider with a schema-owned physical codec.
 */
export class SqliteSessionPersistence extends CoordinatedSessionPersistence<number> {
  override readonly supportsRawArtifacts = false
  override readonly name = 'session-persistence-sqlite'

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    busyTimeoutMs: z.number().step(1).min(0).max(MAX_BUSY_TIMEOUT_MS).default(DEFAULT_BUSY_TIMEOUT_MS),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  private readonly store: SqliteStore
  protected readonly coordinator: PersistenceCoordinator<number>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
      ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    this.store = new SqliteStore({
      path: config.path,
      journalMode: config.journalMode ?? 'wal',
      busyTimeoutMs: config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    })
    this.coordinator = new PersistenceCoordinator(this.ctx, this.store, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    })
  }

  /** Reject self-contained path and ownership failures without loading Node SQLite. */
  protected async [Service.init](): Promise<void> {
    await this.store.validatePath()
  }

  /** SQLite has one database, not an independent per-session artifact. */
  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  // The coordinator-delegated service API lives on CoordinatedSessionPersistence.
  // Listing is not one of its operations: the coordinator only consumes `list`
  // as a backend hook, so both listings read the store directly.

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return this.store.list(signal)
  }

  listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    return this.store.listSnapshots(signal)
  }
}

export default SqliteSessionPersistence
