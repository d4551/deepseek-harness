---
description: "Hosted-workspace patch layer for dsh: the session workspace is backed by a WebDAV network drive instead of host disk, so a server-run harness keeps a workspace that outlives the machine."
kind: "package-bundle"
---

# @deepseek-ai/dsh-hosted-drive

English | [中文](README.zh.md)

## Summary

`dsh-hosted-drive` moves the session workspace off the host's disk and onto a WebDAV network drive. Apply it after `dsh-base` and `dsh-web-app` and the harness runs the same way it always does — same tools, same sandbox, same shell — except that the directory every tool sees is a mirror of remote storage, written through as the model works. It exists for hosted deployments: a harness on a server that must not keep a user's files on that server's disk, and whose workspace has to survive the machine it ran on. The main boundary: one drive per deployment, configured by environment, and the drive is the only arbiter of concurrent writes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

<a id="use-this-package"></a>

### Configuring the drive

Environment variables drive the layer:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_DRIVE_URL` | required | absolute `http(s)` URL of the WebDAV collection |
| `DSH_DRIVE_USERNAME` / `DSH_DRIVE_PASSWORD` | required | the collection's credentials |
| `DSH_DRIVE_WORKSPACE` | required | absolute local directory the drive materializes into |
| `DSH_DRIVE_REMOTE_ROOT` | drive root | drive subtree to mirror |
| `DSH_DRIVE_MAX_FILE_BYTES` | `10485760` | ceiling on one file this layer transfers in either direction |
| `DSH_DRIVE_REQUEST_TIMEOUT_MS` | `30000` | deadline for one drive request |
| `DSH_PERMISSION_MODE` | `workspace-write` | sandbox mode the layer restates |

`DSH_DRIVE_WORKSPACE` is also what `sandbox-policy` fences by. Changing one without the other splits the execution world, and the patch sets both from the same variable so they cannot drift.

The two ceilings are the layer's own, not the drive-backed provider's: 10 MiB is a tenth of what `fs-network-drive` allows on local disk, because every byte here crosses the network twice, and a deployment on a fast link or a plan with different limits raises or lowers both without editing the bundle.

## Understand the implementation

<a id="understand-the-implementation"></a>

### Patch surface over base

The layer replaces rather than adds. `fs-sandbox` — the host-local provider `dsh-base` inserted — is disabled, because two `ctx.fs` providers in one tree would give the model two workspaces. In its place the patch inserts [`network-drive-webdav`](../../fs/network-drive-webdav/README.md) as the drive and [`fs-network-drive`](../../fs/fs-network-drive/README.md) as the filesystem backend over it, and restates `sandbox-policy` so the fence names the materialization root.

### One execution world

Bash, the persistent terminal, ripgrep, the language servers, and the file tools all resolve paths through `processPath()`, which answers with a real directory inside the materialization root. None of them knows the workspace is remote, and none of them needs to.

That property is checked while the harness runs, not assumed from the patch. The layer's own rows set the fence and the materialization root from one variable, but a profile's `cordis.patch.yml` or a `dsh --patch` overlay can restate either row alone, and the split world that follows lets a command write where the fence does not reach while the drive never sees it. So the patch also inserts the [invariant registry](../../runtime-diagnostics/invariants/README.md) and this package's companion, which compares the live `fs.materializationRoot` against the live `sandboxPolicy.resolve().workspaceRoot` — both canonicalized — at every `fs/observed` and fails the run when they name different directories.

Runtime invariants are otherwise off in every shipped tree ([decision](../../../.agents/notes/implemented/simplification/2026-08-03-omit-invariants-from-shipped-config.md)), so the registry row carries a `package_allowlist` naming only `@deepseek-ai/dsh-hosted-drive`: a hosted run gains this layer's check and no other package's diagnostics. A deployment that wants more widens that row like any other config.

## Further Exploration

<a id="further-exploration"></a>

- [Network drive Service Definition](../../fs/network-drive/README.md) — the seam a different backing store would implement.
- [WebDAV provider](../../fs/network-drive-webdav/README.md) — the shipped drive.
- [Drive-backed filesystem](../../fs/fs-network-drive/README.md) — hydration, write-through, and the materialization root.

## Model Experience

Indirectly, through the file and shell tools this layer re-points, which render every path and byte the model sees as ordinary local paths under the materialization root.

#### KV Cache effect

None: the bundle contributes no prompt text and reorders no request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One drive per deployment.** The layer configures a single collection from environment variables; a deployment serving several users from one process would need per-session drive selection, which the patch layer has no place to express.
- **The drive arbitrates concurrency, and only if it serves versions.** Two harnesses on one collection interleave writes; a guarded write reports the conflict when the server serves an ETag and cannot guard at all when it does not.
- **Authentication is password-only here.** The WebDAV provider also supports digest and bearer tokens, but this patch wires the password form, so a token-authenticated collection needs its own overlay row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
