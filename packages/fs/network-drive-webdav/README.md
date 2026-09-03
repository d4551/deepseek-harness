---
description: "The WebDAV backend for ctx.networkDrive for deployments pointing a hosted workspace at an existing WebDAV collection."
kind: "package-reference"
---

# @deepseek-ai/dsh-network-drive-webdav

English | [中文](README.zh.md)

## Summary

The shipped `ctx.networkDrive` provider, reaching a WebDAV collection through the maintained `webdav` client. WebDAV is the one open standard ordinary hosting already speaks, so a deployment that has a collection gets a hosted workspace without running anything new. Credentials are named rather than inlined, and every operation honors the caller's cancellation.

## Table of Contents

- [Use this package](#use-this-package)
- [Ranged reads](#ranged-reads)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The shipped [`ctx.networkDrive`](../network-drive/README.md) provider: a WebDAV collection, reached with the maintained [`webdav`](https://www.npmjs.com/package/webdav) client rather than a hand-written PROPFIND parser.

## Why WebDAV

It is the one open standard for a remote filesystem that ordinary hosting already speaks: Nextcloud, SharePoint, Box, and macOS and Windows all mount a WebDAV collection as a network drive. A deployment that already has one gets a hosted workspace without running anything new.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `url` | required | absolute `http(s)` URL of the collection backing the drive root |
| `authType` | `password` | `none`, `password`, `digest`, `token`, or `auto` |
| `usernameEnv` / `passwordEnv` | — | credential references for `password`, `digest`, and `auto` |
| `tokenEnv` | — | credential reference for `token` |
| `requestTimeoutMs` | see the [config catalog](../../../docs/config-catalog.md) | deadline for one drive operation |

Credentials are named, never inlined: the config carries the name of a credential the [credential seam](../../credentials/credentials/README.md) resolves, so a mounted drive's secret never sits in a composition file. An auth mode that names no credential reference at all fails at mount. A named reference the store cannot resolve fails at the first operation with `DRIVE_UNAUTHENTICATED`, because the credential is read per operation — a rotated secret reaches the next request without a remount.

Every operation threads the caller's `AbortSignal` into the client's own `signal` option, so a cancelled tool call cancels the HTTP request rather than orphaning it.

## Error translation

The provider maps transport failures onto the Definition's closed `DriveErrorCode` union. Statuses the union names — 401, 403, 404, 409, 412, 507 — translate to their own codes; every other status, a 500 included, becomes `DRIVE_IO_ERROR` carrying the original error as its cause. The union is closed, so a consumer switching on it ends in `assertNever` and a new code cannot be added without every consumer being made to handle it.

<a id="ranged-reads"></a>
## Ranged reads

A read with a byte window sends `Range` and then places the answer by its status. A 206 body is the window the server chose, and its `Content-Range` says where that window starts; a 200 body is the whole entity, which the provider cuts from the requested offset itself. Body length cannot tell the two apart — a server ignoring `Range` can return an entity shorter than the requested length — so an answer the provider cannot place fails with `DRIVE_IO_ERROR` instead of returning bytes from an unknown region: any other status, a 206 without a parseable `Content-Range`, and a window served past the requested offset. A window that starts past the end of the file is not an error; the read returns no bytes, which is what the Definition promises when the file ends first.

## Model Experience

Indirectly, through [`dsh-fs-network-drive`](../fs-network-drive/README.md), which projects this drive into `ctx.fs` and owns every path and byte the model sees.

#### KV Cache effect

None: the provider contributes no prompt text and reorders no request.

## Known Limitations and Deferred Work

- **No locking.** WebDAV's `LOCK`/`UNLOCK` are not used, so two harnesses pointed at one collection can interleave writes to a file. The guarded-write intent narrows the window to the gap between a version check and its `PUT`, and closing it fully requires the lock verbs and the lock-token lifetime that goes with them.
- **Versions are whatever the server returns.** A collection that serves no ETag makes every guarded write unguarded, because the provider has nothing to compare. That is a property of the server, and the provider reports it rather than substituting a digest it would have to read the whole file to compute.
- **No range write.** The Definition has none, and WebDAV's `PATCH` byte-range extension is not widely served, so a one-byte edit re-uploads the file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
