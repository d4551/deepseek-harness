---
description: "The ctx.networkDrive capability contract for deployments backing a session workspace with remote storage and developers implementing a drive."
kind: "package-reference"
---

# @deepseek-ai/dsh-network-drive

English | [中文](README.zh.md)

## Summary

The Service Definition for a network drive: seven operations over a remote tree that a hosted deployment implements so a session workspace can live on storage that is not local disk. It carries exactly what `ctx.fs` lacks — directory creation, removal, and rename — because a local backend gets those from the shell and a drive has no shell.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The network-drive capability's Service Definition: `ctx.networkDrive`, the seam a hosted deployment implements to back a session workspace with storage that is not local disk.

## The service

`NetworkDrive` declares seven operations over a remote tree, each taking an `AbortSignal` the provider must honor:

| Operation | Answers |
|---|---|
| `stat(path, signal?)` | the entry's type, size, and opaque `DriveVersion`, or `undefined` when absent |
| `list(path, signal?)` | one directory level |
| `read(path, range, signal?)` | file bytes, whole or over a `DriveByteRange` |
| `write(path, content, intent, signal?)` | the new `DriveVersion`, under a `DriveWriteIntent` |
| `remove(path, signal?)` | removal of one entry |
| `move(from, to, signal?)` | a rename within the drive |
| `makeDirectory(path, signal?)` | directory creation |

These are deliberately the operations `ctx.fs` does not have. The filesystem seam owns reading, writing, and editing a target it already resolved; it has no mkdir, unlink, rename, or watch, because a local backend gets those from the shell. A drive has no shell, so the seam that stands in for one carries them.

## Vocabulary

`DrivePath` and `DriveVersion` are [branded](../../util/brand/README.md) opaque strings. A path is slash-separated and drive-relative; a version is whatever the provider can compare for equality — an ETag, a revision id, a content digest. Consumers never parse either.

`DriveWriteIntent` distinguishes an unconditional write from a guarded one, so a provider can refuse a write whose expected version no longer matches instead of silently overwriting a concurrent change. `DriveErrorCode` is a closed union; a provider translates its transport's failures into it, and a consumer switching on it ends in `assertNever`.

## Composition

The Definition registers no provider. Mount exactly one — [`dsh-network-drive-webdav`](../network-drive-webdav/README.md) is the shipped one — and one consumer, [`dsh-fs-network-drive`](../fs-network-drive/README.md), which projects the drive into `ctx.fs`.

## Model Experience

Indirectly, through the filesystem provider that projects this drive, which owns every path, byte, and error the model sees.

#### KV Cache effect

None: the Definition contributes no prompt text and reorders no request.

## Known Limitations and Deferred Work

- **No watch, and no change notification.** A consumer that must notice a drive-side edit polls `stat`. The seam carries no subscription because the shipped consumer materializes on demand and revalidates by version, and a subscription that no provider could implement uniformly would be a promise the seam cannot keep.
- **No partial write.** `write` replaces a whole file; there is no append or byte-range write, so a consumer editing a large file transfers it whole in both directions. `read` takes a range, so the asymmetry is deliberate: ranged reads are universally available over HTTP, ranged writes are not.
- **No atomic multi-path operation.** `move` is the only two-path operation and providers implement it as the transport allows; there is no transaction spanning several paths, so a consumer needing one builds it from guarded writes and its own recovery.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
