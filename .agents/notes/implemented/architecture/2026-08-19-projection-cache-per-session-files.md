# Agent Note: Projection cache as per-session files

Status: implemented

English | [中文](2026-08-19-projection-cache-per-session-files.zh.md)

## Problem

The persisted projection cache was one global `session_projcache.json` — a `sessions` table in a single file at the storage root. Every throttled checkpoint rewrote the whole file containing every session's rows, so write amplification grew with session count, and one malformed file took the entire cache down at once.

## Decision

The cache opens the `session_projcache` storage domain in the `per-record` layout: one version-stamped document per session at `<root>/session_projcache/sessions/<id>.json`, owned by the storage stack. The [shared base bundle](../../../../packages/bundle/base/cordis.patch.yml) mounts `storage`, `storage-json`, `storage-domain` and the cache, with the JSON root at `dshHomePath('storages')`. Every shipped base-backed profile keeps the cache enabled, so the session producer records checkpoints independently of whether its current application exposes a listing interface; `sdk-minimal`, which does not use the base bundle, remains outside this composition. The cache does not locate or read session-log artifacts; consumers supply history to its reconstruction methods.

Reads and writes share one coherent state: every `cachedSnapshot` read is a synchronous lookup in the domain's in-memory tables, and every write queues on the domain's per-unit write chain, mutating memory only after durability. Checkpoints are mandatory at session creation, `turn/end` and disposal, with count and interval triggers between those points. A consumer supplies authoritative history to `coldSnapshot` for reconstruction and durable write-back; failed write-back logs a warning and leaves the next read to reconstruct again. The JSON backend requests owner-only directory permissions (`0o700`).

## Consequences

- Per-session write isolation: each throttled write replaces only that session's small document, removing the global write amplification. The domain write chain serializes writes, so a newer cut never lands before an older one; domain close drains in-flight writes.
- Listing is a synchronous in-memory read; a session without a record document simply lacks the projection column.
- ACP, headless, SDK, and Web sessions publish cache rows for later consumers. The log-leading durability barrier may flush a covered prefix at the cache cadence and split otherwise coalesced physical JSONL runs; recorded profile snapshots re-pack the logical event stream so cache timing does not define fixture layout.
- The JSON backend reads malformed, stale-version or unreadable record documents as absent without deleting them. For a loaded value that fails the checkpoint schema, the domain's explicit `rebuildable: true` table policy durably deletes only that record and logs its location; valid neighbors survive. The [storage-root and recovery decision](2026-07-28-storage-root-and-derived-medium-recovery.md) owns that policy and its authoritative-data protections. Unit/table read failures and recovery deletion failures reject opening; a directory at a record path is not automatically repaired.
- The JSON backend imports a whole-unit cache only while the tree lacks persistent initialization state and enumeration finds no declared document path. It validates every declared table and path-safe key before durably capturing the complete import snapshot. Interrupted imports finish that snapshot before reads or mutations proceed; close drains initialization. A completed initialization stays authoritative after every record is deleted, while missing session rows refold from the log. An existing unmarked document path, including an unreadable or stale file, establishes tree authority. The source file remains untouched.
- Deletion atomically publishes a small versioned absence document, replacing the checkpoint value. It follows the same durable publication protocol as a put; a later put replaces the absence document. Directory creation persists ancestor entries before publication reports success. Initialization metadata corruption rejects access instead of authorizing a fresh import.
- The cache record is bound to its log lifecycle: the stored `{createdAt, cwd}` identity guards against a recreated id.

## Verification

[Cache recovery tests](../../../../packages/session/session-projection-cache/tests/recovery.spec.ts) run the real Loader and JSON/JSONL services across restarts. They verify schema-invalid record deletion, reconstruction from unchanged history, preserved valid neighbors and workspace bytes, malformed/stale document replacement, unreadable regular-file replacement, and failed deletion. The local run covers macOS; the native Windows permission branch remains unverified locally. This is focused behavioral evidence, not an aggregate coverage or mutation result.

[Initialization recovery tests](../../../../packages/storage/storage-json/tests/initialization-recovery.spec.ts) exercise interrupted imports through a real filesystem obstruction, immutable captured input, final-record deletion, direct mutations, close ownership, and unsafe metadata rejection. [Native publication traces](../../../../packages/storage/storage-json/tests/record-durability.spec.ts) check successful file and ancestor-directory flush ordering on POSIX. These checks do not simulate physical power loss.

## Alternatives considered

- **Keep the global sessions table.** Preserves one-load listing, but keeps the global write amplification and single-file blast radius that motivated the change.
- **Cache-owned per-session files** (`<root>/<session-id>/projection_cache.json`). This puts paths, write chains, in-flight tracking, file permissions and backend-specific behavior in the cache. Reading those files for each listing while throttling writes also makes listing reads lag behind cache state. The storage domain owns both durability and coherent reads.
- **Resolve the path through `sessionPersistence.locate(meta)`** (the file beside the session log). Rejected: the cache would have to guess "beside the log" from a log artifact path (`dirname` + fixed filename), coupling the cache to the persistence service and to a backend's layout.
- **Make `per-record` a mode of the existing unit instead of a separate unit class.** Rejected: the two layouts have different record-state owners — `single` holds committed memory with whole-file publication, while `per-record` reconstructs records from the directory after its owned initialization completes. They remain separate small classes behind one backend, with record keys validated path-safe instead of encoded.
