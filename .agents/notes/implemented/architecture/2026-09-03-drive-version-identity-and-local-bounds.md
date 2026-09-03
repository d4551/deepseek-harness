# Agent Note: Drive-backed version identity and workspace read bounds

Status: implemented

English | [中文](2026-09-03-drive-version-identity-and-local-bounds.zh.md)

## Problem

`dsh-fs-network-drive` versions a working file the drive does not hold with a `local:` token, and `DriveTransfer.checkWriteIntent` admits a `replaceIfVersion` write by comparing that token against the one the caller observed. `DriveAddressing.localVersion` summarized a file larger than `maxFileBytes` as `local:oversize:<size>` to avoid reading a huge file into memory. Size is not identity: another writer replacing an oversize file's contents with different bytes of the same length left the token unchanged, so the guard passed and the write destroyed content the caller had never read. The materialization root is shared with the local execution world — the shell, ripgrep, and language servers write into it without this provider's lock — so a same-length replacement is an ordinary event, not a contrived one.

The same local path had no byte bound at all. `DriveTransfer.hydrated` enforced `maxFileBytes` twice against the drive (the reported size, then the transferred bytes) but handed a `local` placement straight to `readLocal`, which read the whole file with `readFile`. `NetworkDriveFileSystem.readText` takes no caller-supplied bound, so a large shell-created file was read fully into memory; `readBytes` was unaffected because it applies its own `maxBytes`. [packages/AGENTS.md](../../../../packages/AGENTS.md) requires bounds on the complete result.

`readLocal` also misclassified a vanished workspace copy. A `node:fs` `ENOENT` is neither an `FsError` nor a `DriveError`, so `mapError` took its generic arm and reported `FS_IO_ERROR`, while the drive's own `DRIVE_NOT_FOUND` and every read path in `dsh-fs-local` report `FS_NOT_FOUND` for the same fact.

Finally, the provider judged binary content two ways — `readText` over the seam's leading sample, `diffBasis` over every byte — with nothing at either site saying the difference was intended.

## Decision

**A working file's version is the digest of its whole content, whatever its size.** `localVersion` streams `digestOfFile` for every regular file; no size short-circuit and no size-derived token remain, and `local:oversize:<size>` no longer exists. Streaming is what makes this affordable: the digest costs one stream chunk of memory for a file of any size, which is stricter than the whole-file `readFile` the under-ceiling path used before. Anything that is not a file still takes its kind as its version.

**The materialization ceiling binds the workspace side of hydration exactly as it binds the drive side.** `hydrated` refuses a `local` placement whose reported size exceeds `maxFileBytes` before reading anything, and `readLocal` reads through `readBounded`, which stops one byte past the ceiling and refuses what comes back longer. The second check lives at the read because the size a placement reported is not a bound on the read: the local execution world writes into this directory without the provider's lock, and a materialization root outlives the ceiling any one session booted with. One private `tooLarge()` builder now owns the `FS_TOO_LARGE` wording for all four sites (drive-reported size, transferred content, workspace-reported size, workspace content) and for `publish`, so the model reads one sentence whichever side refused.

**No local read is unbounded, including the cache probe.** `verifiedCopy` reads through `readBounded` at the recorded length, because a copy that outgrew its record cannot be the recorded content: the one byte past the record proves the mismatch, and a copy a shell grew to any size is never held. The record's digest, not its length, remains what decides a hit.

**`mapError` classifies a `node:fs` `ENOENT` as `FS_NOT_FOUND`**, with the message its `DRIVE_NOT_FOUND` arm already produces. The classification lives in the one place this provider translates local failures, so `localVersion` and the `streamText` iterator report it too, not only `readLocal`.

**The binary sample is deliberately asymmetric, and both sites say so.** `readText` judges the leading `BINARY_SAMPLE_BYTES` the seam defines — the same sample `dsh-fs-local` reads — because a caller asking for a file's text should not pay a whole-file scan on every read. `diffBasis` judges every byte because a basis is offered rather than asked for: a NUL deeper in the file costs only the basis, and declining one never fails the write.

## Verification

`packages/fs/fs-network-drive/tests/filesystem.spec.ts` pins the guard: an oversize working file replaced with different bytes of the same length changes version and rejects the stale `replaceIfVersion` write, leaving the replacing content on disk. Restoring the `oversize:` token fails it on the version comparison.

`tests/hydration.spec.ts` pins the ceiling on the workspace side at a one-byte limit, at exactly the limit, and over a multibyte file whose UTF-8 length differs from its string length, then pins `readLocal` refusing an over-ceiling copy and reporting a missing one as `FS_NOT_FOUND`. `tests/write.spec.ts` pins that a write of content under the ceiling still publishes over an oversize working file, with `before: null` — the behavior a fail-closed token would have removed. A workspace copy removed under an open `streamText` iterator reports `FS_NOT_FOUND` through the seam.

`tests/hydration.spec.ts` also pins the asymmetry itself: a file whose first NUL sits past the sample reads as text and yields no diff basis. Its cache-miss case now tampers with the workspace copy at the recorded length, so the digest rather than the length is what the bounded probe proves.

No recorded-session snapshot exercises this provider — it ships in the opt-in `hosted-drive` patch bundle rather than a default profile — so the real-composition suite booted from `tests/fixtures/composition/cordis.yml` remains the top of this package's evidence.

## Alternatives considered

**A token that never compares equal for an oversize file.** Fails closed, and closes too much: no oversize working file could ever be replaced, while `publish` legitimately writes content under `maxFileBytes` over one. That is a functional regression traded for a data-loss bug, and `tests/write.spec.ts` now pins the behavior it would have broken.

**`size` plus `mtime` as a cheap change detector.** Rejected because mtime granularity is one second on some filesystems and coarser across network mounts, so two same-size edits inside one second still produce the same token. It narrows the window that loses an update without closing it, and leaves the same silent failure mode.

**A digest over a head and tail sample plus the size.** Cheaper than a full digest and still forgeable: an edit in the middle of the file keeps every sampled byte. It buys a fraction of the I/O for the same class of bug.

**Keep the size branch and stream only files above the ceiling.** Rejected because the branch existed solely to avoid `readFile` on a huge file, and streaming removes that reason at every size. One path is cheaper to reason about, and the under-ceiling path stops holding a whole file in memory as a side effect.

**Bound the workspace read only by the placement's reported size.** Rejected because a size measured before the read is not a bound on the read when another writer shares the directory; the bound has to hold where the bytes are actually taken.

**Make `readText` scan every byte, or make `diffBasis` sample only the leading bytes.** Rejected in both directions. Widening the read would make every read of every file scan every byte to refuse content the seam calls text, and would diverge from `dsh-fs-local` at a shared seam. Narrowing the basis would hand a `before` string carrying an embedded NUL to a diff renderer.

**Correct the `ENOENT` classification inside `readLocal`.** Rejected because `localVersion` and the `streamText` iterator translate the same `node:fs` failures through the same `mapError`; a fix at one call site would have left the other two answering `FS_IO_ERROR` for a missing file.

## Consequences

- Locating a working file the drive does not hold streams its whole content to version it, including a file above the ceiling that the following read then refuses. Memory stays bounded; the I/O is linear in the file and is paid per targeted operation. Directory listing is unaffected — a local-only child carries no version.
- An oversize working file is no longer readable through `ctx.fs`: `readText`, `streamText`, and `editText` report `FS_TOO_LARGE` as `readBytes` already did. Writing content under the ceiling over one still succeeds and reports no diff basis.
- A vanished workspace copy now reports `FS_NOT_FOUND`; a consumer that distinguished this provider's missing copy by `FS_IO_ERROR` sees the seam's not-found code instead.
- `local:oversize:<size>` disappears from the version vocabulary. Nothing parses a version token — `isProviderVersion` only reads the authority prefix — so a session log holding an old token stays readable and its guard simply fails as stale, which sends the model back to a fresh read. `SESSION_FORMAT_VERSION` is unchanged.
