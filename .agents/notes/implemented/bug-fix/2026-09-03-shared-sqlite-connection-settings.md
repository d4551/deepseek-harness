# Agent Note: Shared SQLite connection settings

Status: implemented

English | [中文](2026-09-03-shared-sqlite-connection-settings.zh.md)
## Problem

Two packages open SQLite databases, and only one of them hardened the connection.

[`session-persistence-sqlite`](../../../../packages/session/session-persistence-sqlite/README.md) applied `trusted_schema = OFF`, `mmap_size = 0`, and `synchronous = FULL`, read each back, and rejected the open when SQLite reported a different value; it also carried a busy timeout and waited out a competing writer during the journal-mode transition. [`storage-sqlite`](../../../../packages/storage/storage-sqlite/README.md) applied `foreign_keys`, `journal_mode`, and a `user_version` check, and nothing else.

`trusted_schema = OFF` is the load-bearing one. With it on, opening a database file that another account can write lets that file's views, triggers, and index expressions run SQL functions at open time. The storage hub holds the workspace registry and the settings document, so it opens files under the Harness home on every start.

`storage-sqlite`'s README described the gap as a duplication to be tidied later: "`openDatabase` mirrors the session-persistence SQLite open sequence; extraction into a shared medium layer is deferred to the planned session-backend migration." That sentence was false in the direction that mattered. The sequence did not mirror the session one; it was a strictly weaker subset, and reading the README gave no reason to look for a missing security control.

## Decision

[`@deepseek-ai/dsh-sqlite-connection`](../../../../packages/util/sqlite-connection/README.md) owns the settings. Both backends apply them through it, so there is one place where a Harness SQLite connection is defined and one place to change it.

Each setting is applied and then read back, and a value SQLite does not report as requested fails the open. A build that silently ignores a pragma therefore cannot serve a connection that only looks hardened. The pragma statements are fixed constants in the module; no caller supplies pragma text for them, so no call site can weaken a setting by passing a different string.

The busy timeout is the one caller-varying value. It is a validated field on each consuming package's own `Config`, bounded by `MAX_BUSY_TIMEOUT_MS` — SQLite's signed millisecond limit — rather than a constant in the shared module, because the session log and the storage hub have different contention.

`journal_mode` stays with each backend. It is a per-database physical choice, not a connection setting, and the two packages pick different modes.

## Alternatives considered

**Copy the missing pragmas into `storage-sqlite`.** It closes the same hole with a smaller diff, and it is what the README's "deferred" sentence had been describing for as long as the sentence existed. It also reproduces the original failure: two open sequences that must be changed together, with nothing forcing the second to follow the first. `bun run duplication` would then have reported the copy as a clone.

**Give `storage-sqlite` the session package's `openDatabase` directly.** The session function takes an injected `DatabaseSync` constructor and performs schema ownership checks the storage hub does not have, so the storage caller would pass arguments describing a session database.

**Leave the settings unshared and document the difference.** The asymmetry was already documented, inaccurately, and being documented did not make it visible. An unexplained difference between two parallel values is a missed extraction, not a fact to record.

## Consequences

The storage hub now refuses to open a database whose connection cannot be hardened, where before it opened one silently. A deployment whose SQLite build does not support one of these pragmas fails at open with the setting named, rather than running unprotected.

Both backends gained a `busyTimeoutMs` they did not previously expose, and the storage hub gained the journal-mode retry, so a competing writer during a mode transition now waits instead of failing the open.

The two open sequences can no longer drift: a change to schema trust, memory mapping, or commit synchronization reaches both consumers, and `bun run duplication` fails if either grows its own copy.
