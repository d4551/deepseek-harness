---
description: "The drive-backed ctx.fs backend for deployments running a hosted workspace and maintainers debugging hydration or write-through."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-network-drive

English | [中文](README.zh.md)

## Summary

The `ctx.fs` backend that projects a network drive into the filesystem seam. It keeps a real local materialization root so `processPath()` answers with a path ripgrep, the shell, and the language servers can open; reads hydrate on demand and revalidate by drive version, and writes publish to the drive before reporting success.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The `ctx.fs` backend that projects a [network drive](../network-drive/README.md) into the filesystem seam, so a hosted session's workspace lives on remote storage while every local tool keeps working.

## Why it materializes

`FileSystem.processPath()` must return a path a real OS process can open. `tool-fs-search` spawns ripgrep; `bash-local`, `terminal-bash`, and `lsp-stdio` spawn processes; `sandbox-local` fences by real paths. A backend that answered with a URI would break all of them.

So this provider keeps a **materialization root**: a real local directory the drive's subtree is mirrored into on demand. `processPath()` returns a path inside it, and ripgrep, the shell, and the language servers see an ordinary workspace.

Address resolution assigns an identity without transferring content. Reads hydrate on demand and revalidate against the drive's `DriveVersion` rather than a timestamp. Writes commit to the drive before replacing the local copy. A rejected remote commit leaves the previous revision intact. If local publication fails after a successful remote commit, the operation reports the error and a later read can hydrate the committed bytes.

Local operations verify existing path ancestry against the canonical materialization root. Links that leave the workspace are denied, including links redirecting private staging or cache records; internal links remain usable. `lstat` can still report a final link itself. Stream readers repeat ownership checks when consumption begins.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `materializationRoot` | required | absolute local directory the drive mirrors into |
| `remoteRoot` | the drive root | slash-separated drive path whose subtree is mirrored |
| `maxFileBytes` | see the [config catalog](../../../docs/config-catalog.md) | ceiling on one file in either direction |

`materializationRoot` must be the same directory the sandbox policy fences by. That is the one-execution-world rule every swapped backend follows: the filesystem, the shell, and the confinement all have to name one workspace, or a command can write where the fence does not reach.

## Model Experience

Indirectly, through the `read`, `write`, `edit`, `glob`, and `grep` tools, which render every path and byte. The model sees ordinary local paths under the materialization root and cannot tell the workspace is remote — which is the point.

#### KV Cache effect

None: the backend contributes no prompt text and reorders no request.

## Known Limitations and Deferred Work

- **Path checks are not atomic with local I/O.** Native path resolution detects existing symlink escapes, but another process can rename directories between a check and a subsequent filesystem operation. Hostile concurrent writers require operating-system confinement; this provider does not implement descriptor-relative atomic traversal.

- **One writer per drive subtree.** A second harness pointed at the same remote root can publish between this one's version check and its write. Every drive serves a version — the WebDAV provider falls back to modification time and size when a collection omits ETags — so the compare-and-set check always runs; what a missing ETag costs is the *atomic* remote guard (`If-Match`), leaving a window between the check and the `PUT` rather than removing the check.
- **A shell `rm` or `mv` in the workspace does not reach the drive.** The `ctx.fs` seam has no unlink or rename, so deletions and renames happen through the shell against the materialization root. The drive still holds the file, and the next hydration brings it back. Closing this needs the drive seam's `remove` and `move`, which exist for it and have no consumer yet.
- **The materialization root is not garbage collected.** A hydrated file stays until the root is removed, so a long session over a large drive grows toward the size of what it touched. Eviction needs a policy — age, size, or pinning — that no consumer has yet stated.
- **A drive-side edit is invisible until something restats.** There is no watch in the Definition, so a file changed on the drive after hydration is served from the local copy until an operation revalidates it.
- **A working file the drive does not hold costs its own size to identify, and is unreadable above `maxFileBytes`.** Nothing has published it, so its version is the digest of its content: `stat`, `read`, and `write` stream the whole file to derive one, and a file over the ceiling is refused rather than served. A drive file is identified by the revision the drive already reported, which costs no read at all.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
