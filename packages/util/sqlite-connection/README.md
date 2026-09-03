---
description: "The owner-only path preparation and SQLite connection settings every Harness database backend applies and verifies: exclusive file creation, schema trust off, memory mapping off, synchronous FULL, and a journal-mode transition that waits out a competing writer."
kind: "package-reference"
---

# @deepseek-ai/dsh-sqlite-connection

English | [中文](README.zh.md)

## Summary

`dsh-sqlite-connection` owns the settings a Harness SQLite connection must hold before a backend uses it: schema trust off, memory mapping off, `synchronous=FULL`, and a journal mode the connection actually reports. Every setting is applied and then read back, so a SQLite build that accepts a pragma and quietly keeps the old value fails the open instead of serving a connection the backend believes is hardened. The pragma text for these settings is fixed inside this package; a backend supplies only its journal-mode statement and the busy deadline. It also owns the one filesystem step that precedes every connection: creating the database file and its parent directory with owner-only permissions. It is a zero-dependency library shared by the session-persistence and storage SQLite backends, so both hold the same guarantees; it opens no connection and knows nothing about either package's schema.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

A backend that opens a SQLite database prepares its path, then calls the three connection steps in order around its own schema work, and keeps the handle.

```ts
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import {
  configureConnectionSecurity,
  configureDurability,
  prepareDatabasePath,
  selectJournalMode,
  type SqliteDatabaseSubject,
} from '@deepseek-ai/dsh-sqlite-connection'

declare const path: string
declare const busyTimeoutMs: number
declare function validateSchema(db: DatabaseSync): void

const actual = await prepareDatabasePath(path)
const database: SqliteDatabaseSubject = { path: actual, role: 'storage database' }
const deadline = performance.now() + busyTimeoutMs
const db = new DatabaseSync(actual, { timeout: busyTimeoutMs })
try {
  configureConnectionSecurity(db, database)
  validateSchema(db)
  await selectJournalMode(db, database, {
    statement: 'PRAGMA journal_mode = WAL',
    mode: 'wal',
    deadline,
  })
  configureDurability(db, database)
} catch (error: unknown) {
  db.close()
  throw error
}
```

### Prepare the path before connecting

`prepareDatabasePath(path)` resolves the path, creates its parent directory with mode `0o700`, and creates the database file itself with `wx` and mode `0o600`, then returns the path to open; `:memory:` names no filesystem entry and passes through untouched. An existing file keeps its own modes, and any error other than `EEXIST` propagates. A backend that must inspect the path between those steps — validating ownership or rejecting a symlinked parent — calls `createDatabaseFile(path)` itself after its own checks.

### Order the steps this way

`configureConnectionSecurity` comes first, before any statement that can reach a view, trigger, or index expression: with schema trust on, opening a database file another principal can write runs functions those objects name. `configureDurability` comes last, after the journal-mode transition, so the level SQLite reports is the one the connection keeps. Each call throws on the first setting the connection does not honor, and the caller closes the handle — a failed sequence must never leave a half-configured connection in use.

### Bound the wait on a competing writer

`DEFAULT_BUSY_TIMEOUT_MS` (5,000) and `MAX_BUSY_TIMEOUT_MS` (2,147,483,647, the largest value SQLite's signed millisecond interface accepts) are the shared bounds for a backend's own validated `busyTimeoutMs` configuration field. Pass the same value to the driver as `timeout` and into the journal deadline: SQLite answers the exclusive journal-mode transition with `SQLITE_BUSY` instead of waiting on the connection's busy timeout, so `selectJournalMode` retries that one statement itself until the deadline passes.

### Read the settings back

`readConnectionSettings(db)` returns `{ trustedSchema, mmapSize, synchronous }` as the live connection reports them. Backends and their tests use it as evidence that a connection is configured; it reads a file-backed connection, since an in-process database answers `PRAGMA mmap_size` with no row at all.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Path preparation, the three configure steps, `readConnectionSettings`, the busy-timeout bounds, and the connection types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; the settings live on the caller's connection) |

### Why every setting is read back

`PRAGMA` is a request, not a promise: SQLite parses unknown or unsupported pragmas without error and returns the value it actually kept. A build compiled with `SQLITE_TRUSTED_SCHEMA` forced on, a driver that ignores `mmap_size`, or a filesystem that refuses the WAL transition would otherwise leave a backend documenting a guarantee it does not have. Reading the value back converts each of those into a loud open failure naming the setting and the database.

### Why the journal transition retries

A journal-mode change takes an exclusive lock. SQLite returns `SQLITE_BUSY` for it immediately rather than invoking the connection's busy handler, so a second process opening the same database at the same moment would fail an open that the configured busy timeout was meant to cover. The retry paces attempts 10 ms apart and stops at the caller's deadline, which keeps the total wait inside the same bound as every other contended statement.

### What stays with the backend

Validating path ownership, rejecting a symlinked parent, choosing which journal modes are durable enough to accept, and owning the schema all stay in the backend. Beyond creating the file and its parent directory owner-only, this package sees an open connection and a name to put in its failure messages.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SQLite session persistence](../../session/session-persistence-sqlite/README.md) — the session backend that consumes these settings.
- [SQLite storage backend](../../storage/storage-sqlite/README.md) — the storage-hub backend that consumes them.
- [Shared SQLite connection settings Agent Note](../../../.agents/notes/implemented/bug-fix/2026-09-03-shared-sqlite-connection-settings.md) — why one owner holds them.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package only prepares a host-side database path and connection and registers nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Settings are connection-local** — none of them persist in the database file, so a connection some other code opens on the same file holds none of them; every opener applies them itself.
- **The requested journal mode is not judged** — the verification only proves the connection reports the mode the caller asked for; refusing a non-durable mode such as `memory` or `off` stays with each backend's validated configuration.
- **`readConnectionSettings` needs a file-backed connection** — an in-process database returns no `PRAGMA mmap_size` row, so callers reading an in-process connection query the settings they care about directly.
- **No path validation** — symlink and ownership checks belong to the backend; owner-only creation loses to a parent directory another principal can write, and a hardened connection to a file another principal can replace is still a file another principal can replace.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
