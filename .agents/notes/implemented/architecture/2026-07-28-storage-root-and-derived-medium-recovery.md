# Agent Note: Storage root placement and derived-medium recovery

Status: implemented

English | [中文](2026-07-28-storage-root-and-derived-medium-recovery.zh.md)

## Problem

The persisted projection cache needs stable storage placement and recovery appropriate to derived data. Resolving a relative backend root after a working-directory change can split one backend's records across directories. Rejecting an entire cache because one checkpoint fails its schema can prevent initialization even though authoritative session history can reconstruct the missing value. Authoritative workspace records need the opposite protection: opening damaged data must not delete it.

## Decision

### One shared storage root, resolved at construction

The [base bundle](../../../../packages/bundle/base/cordis.patch.yml) configures `storage-json.root` with `!!js dshHomePath('storages')`, beside the session root. The [home resolver](2026-07-24-single-harness-home-resolver.md) owns `$DSH_HOME` and the default `~/.dsh`; compositions do not duplicate its path rules. A deployment can override the owning plugin row through its configuration patch layers.

[`JsonStorageBackend`](../../../../packages/storage/storage-json/src/index.ts) captures `resolve(root)` at construction. First open, operations through existing handles, and later unit opens all use that location across working-directory changes. Resolution neither moves existing files nor resets records. Shared placement protects both the cache and authoritative `workspace.json`.

### Explicit recovery of individual derived records

[`DomainTableSpec`](../../../../packages/storage/storage-domain/src/spec.ts) carries `rebuildable?: true`; `domainTable(schema, { rebuildable: true })` declares records reconstructible from an authoritative source. The [projection-cache spec](../../../../packages/session/session-projection-cache/src/spec.ts) opts its `sessions` table into this policy and retains version 4 and the `per-record` layout. The [per-session files decision](2026-08-19-projection-cache-per-session-files.md) owns the medium layout and write-isolation rationale.

[`DomainFacility.open`](../../../../packages/storage/storage-domain/src/index.ts) validates values returned by the backend against each table's schema. A schema-invalid value in a declared rebuildable table is durably deleted through `KvUnit.deleteRecord`; a warning identifies the domain, table and key. Valid neighboring records remain intact. Backend read or deletion failures that reach the facility reject open, and the facility publishes the domain only after validation and recovery complete. This is record deletion during one open, with no whole-domain destruction or reopen loop.

Tables without the declaration preserve schema-invalid records and reject with `invalid-record`. Invalid globals always reject. Removing a derived checkpoint does not touch authoritative session history or workspace data. Consumers supply session history to the cache's `coldSnapshot` to reconstruct the checkpoint; normal cache writes persist the reconstructed value.

The JSON per-record backend expresses durable deletion with a versioned absence document that contains no checkpoint value. Its persistent initialization state prevents a retained whole-unit source from restoring the deleted record. Reconstruction atomically replaces the absence document; the [per-session files decision](2026-08-19-projection-cache-per-session-files.md) owns initialization and publication details.

### Backend damage and schema damage have different owners

The JSON [per-record reader](../../../../packages/storage/storage-json/src/per-record-unit.ts) presents malformed, differently versioned and unreadable record documents as absent without deleting them. The domain recovery policy applies only to values that reader returns. Later atomic replacement can rebuild an unreadable regular file when its directory permits replacement; a directory occupying a record path is not automatically removed. Unit or table enumeration failures, source-file read failures during whole-unit import, and deletion failures remain observable. The JSON single-document reader rejects malformed or differently versioned media; the rebuildable-table option does not reset a backend that rejects before record validation.

## Alternatives considered

**Per-launch-directory storage.** Session history is global, so directory-dependent storage splits derived checkpoints from their authority and makes workspace records depend on the launch location.

**A launcher patch plus a separate `storageRoot` profile key.** The owning plugin row already accepts a path expression and deployment overrides. A second rewrite point duplicates the root policy without adding a consumer requirement.

**Only a global cache root, leaving workspaces per directory.** Workspace records need the same location stability. One backend root keeps both media co-located.

**Recovery inside the cache plugin.** Naming or deleting backend files there would cross the storage abstraction and duplicate schema recovery for each derived consumer. The domain facility already owns record validation.

**An ephemeral in-memory domain after damage.** It would silently lose durability for the process lifetime and leave the damaged medium unrepaired at the next boot.

**Rename damaged derived records aside.** Session history supplies reconstruction, while unbounded retained copies accumulate. This decision grants deletion only to explicitly reconstructible records; authoritative recovery requires its own preservation policy.

**Reset every domain automatically.** Workspace records are authoritative user data. Their schema failure cannot authorize deletion; owners declare reconstructibility per table.

**Whole-domain reset through `KvFacet.destroy`.** One invalid session checkpoint does not justify discarding valid neighbors or adding a destructive backend operation. Record-level recovery uses the existing deletion contract and preserves unaffected data.

## Consequences

Root placement is stable across launches and subsequent working-directory changes. A schema-invalid derived checkpoint costs reconstruction from session history; it does not prevent the rest of the cache from opening. A mistaken rebuildable declaration can delete data, so the table owner must have an authoritative reconstruction source. Recovery is not a transaction over all tables: a later failure does not restore derived records already deleted. Environmental failures are not reclassified as schema damage by the domain layer.

## Verification

[Root-location tests](../../../../packages/storage/storage-json/tests/root-location.spec.ts) exercise both layouts before the first open and during an open handle's lifetime. [Domain recovery tests](../../../../packages/storage/storage-domain/tests/recovery.spec.ts) check durable removal, retained neighbors, rejection of invalid authoritative records and globals, and failed unit reads. [Cache recovery tests](../../../../packages/session/session-projection-cache/tests/recovery.spec.ts) use real Loader, JSON storage and JSONL history across restarts, including a restart before reconstruction, unchanged workspace and session-log bytes, unreadable-record replacement, and denied deletion. Local evidence is from macOS; the permission fixture's native Windows ACL path is not verified locally. These checks do not establish repository-wide coverage, mutation or platform completion.
