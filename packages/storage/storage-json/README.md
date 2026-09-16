---
description: "JSON storage backend for hosts and maintainers choosing, configuring, or debugging whole-unit and per-record files under a configured root."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-json

English | [中文](README.zh.md)

## Summary

`dsh-storage-json` stores domain data as readable JSON under a configured root and registers as backend `json`. Its default `single` layout keeps one complete `<unit>.json` file per unit; its `per-record` layout keeps one version-stamped document per record. Both layouts publish each changed file atomically, while the domain layer orders calls. Choose it when operators need inspectable files and the selected layout fits the write volume; choose SQLite for larger or highly concurrent data. The backend is host-side only and contributes no prompt, tool, or schema.

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

Use this package when a composition needs readable, editable JSON storage. Route the relevant domains to backend `json`; each domain specification selects the `single` or `per-record` layout.

### When to choose it

Choose the default `single` layout for small units that benefit from one complete, pretty-printed file. Choose `per-record` when point writes should replace only one record document. Choose the SQLite backend when data is large, writes are frequent, or multiple records need transactional updates.

### Configuration

The only plugin field is `root`, which holds the unit files and directories. It is required and resolves to an absolute path when the backend is constructed; later working-directory changes cannot redirect reads or writes. The backend creates the root with mode `0o700` on demand. A domain specification selects its layout; this plugin has no layout override.

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: /var/lib/dsh/data
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

| Field | Default | Meaning |
|---|---|---|
| `root` | required | Directory holding `<unit>.json` files and `<unit>/` trees; created `0o700` on demand |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-storage-json) is the exhaustive source for every accepted field and its JSDoc.

### Observable behavior

A missing `single` file opens as an empty unit and materializes on the first write. A `per-record` unit checks initialization before each read or mutation; an empty read with no usable import source leaves the tree unmaterialized so a corrected source can be read later. Its first mutation establishes persistent tree authority. In `single`, malformed content rejects with `malformed-medium`, and a different stored version rejects with `version-mismatch`. In `per-record`, each malformed, unreadable, differently versioned, or deleted record reads as absent, so one bad record document does not reject the unit. Record keys must match `[a-zA-Z0-9_-]+`; an unsafe key rejects before any file operation. Every resolved write is durable, and operations after close reject with `closed`.

Whole-unit documents use only own entries in `tables`; a declared table with no stored entry opens empty, even when its name is `constructor`. Record values retain native JSON parsing semantics, including own keys named `__proto__`, `constructor`, and `prototype`.

In `single`, `loadAll()` reads the last successfully published state. Pending or rejected writes do not change that state, and closing the unit waits for pending publication before releasing it for another open. Callers must serialize writes to a unit; the domain layer supplies this ordering.

`JsonStorageBackend.close()` rejects new opens and waits for pending `kv.open()` promises to settle before it resolves. If shutdown starts while a unit is opening, a successfully initialized unit is closed instead of returned, and its open rejects with `closed`. Shutdown also closes existing units and drains their pending writes.

Plugin disposal first withdraws the backend's lifecycle service and waits for dependent domains to drain their queued writes. It then unregisters the backend and closes its units. This ordering also applies when the whole composition is disposed.

An uninitialized `per-record` tree can import its declared tables from a valid `<root>/<unit>.json` whole-unit document. Each stored declared table must be an object, and every imported key must satisfy the same path-safety rule as a direct write. Validation completes before publication, and the source file remains unchanged. A durable initialization record captures the complete import snapshot before record writes begin; interrupted imports resume that snapshot even if the source changes. Reads and direct mutations await completion, and close drains initialization. Invalid initialization metadata rejects access.

An initialized tree stays authoritative after every record is deleted. An existing document path in an unmarked tree's declared table, or a declared `global.json`, establishes that authority even when unreadable or stale. Deletes publish explicit absence documents; a later put replaces them with record data. The initialization record and ancestor-directory persistence prevent a preserved import source from repopulating a successfully emptied unit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The two layouts share atomic publication but assign state ownership differently. `single` owns an in-memory unit projection; `per-record` treats its directory tree as authoritative.

### Design concept

- **`single` exposes committed memory.** Each write builds a separate candidate state and publishes its complete `<unit>.json` document before making that state readable. A failed publication leaves the readable state unchanged.
- **`per-record` keeps the directory authoritative.** Each put or delete changes one `<unit>/<table>/<key>.json` document, and `loadAll()` rereads the initialized tree. Each document stamps the unit version and carries a record value or explicit deletion.
- **Publication is durable per call.** A write syncs a same-directory staging file before replacement. POSIX uses `rename()` followed by a parent-directory fsync; Windows uses the [shared publication helper](../../util/atomic-write/src/win32.ts) with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`. The domain layer's write chain supplies ordering across calls.

### File formats

A `single` document carries the unit identity, global singleton, and all tables:

```json
{
  "unit": { "name": "workspace", "version": 1 },
  "global": null,
  "tables": { "workspaces": { "<key>": { "path": "/work/demo" } } }
}
```

A `per-record` table document at `<root>/<unit>/<table>/<key>.json` has the form `{ "version": 1, "record": <value> }` or `{ "version": 1, "deleted": true }`; the optional global value uses `<root>/<unit>/global.json`. The format version comes from the domain specification. `<unit>/.initialization.json` records either a captured import in progress or completion, independently of the number of live records.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: backend registration, `root` config, unit open/close table |
| [`src/unit-lifecycle.ts`](src/unit-lifecycle.ts) | The open-slot lifecycle both layouts share: closed guard, write drain, declared-global check |
| [`src/single-unit.ts`](src/single-unit.ts) | One `single` unit: committed reads and candidate publication |
| [`src/per-record-unit.ts`](src/per-record-unit.ts) | One `per-record` unit: tree reads, path-safe records, and one-document writes |
| [`src/initialization.ts`](src/initialization.ts) | Persistent tree authority and recovery of captured imports |
| [`src/durable-directory.ts`](src/durable-directory.ts) | Directory creation with ancestor persistence |
| [`src/format.ts`](src/format.ts) | Whole-unit and record serialization with version validation |
| [`src/atomic.ts`](src/atomic.ts) | Atomic file replacement: temp write, fsync, rename, directory fsync |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant: correctness is round-trip durability) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when this backend's view is not enough: the subsystem reference is the authoritative contract, and the sibling backend shows the alternative medium.

- [Storage subsystem](../../../docs/subsystems/storage.md) — the backend contract, domain semantics, and generated API.
- [Storage package map](../README.md) — the family's packages and their repository position.
- [SQLite storage backend](../storage-sqlite/README.md) — the point-update medium for high-frequency data.
- [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) — the design behind the backend family and its deferred work.

-----

<a id="model-experience"></a>
## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **`single` rewrites the whole unit** — each write republishes the complete unit file; use `per-record` or route the domain to SQLite when this cost is too high.
- **No cross-process write locking** — two processes writing the same unit can interleave replacements; writes to the same file use last-completion wins.
- **Deletion retains one small absence document per key** until a later put replaces it; removing these files requires a separate durable deletion protocol.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Agent Note flags the whole-unit rewrite scale premise as a risk: if a second consumer lands on this backend at thousand-record scale before being routed to SQLite, rewrite cost surfaces earlier than expected. The mitigation is configuration — point `routes` at the SQLite backend — not a change to this package.

</details>
