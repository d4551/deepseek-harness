# Agent Note: Mount the hosted-drive invariant, and place every ranged drive read

Status: implemented

English | [中文](2026-09-03-hosted-drive-invariant-mount-and-range.zh.md)

## Problem

The hosted-drive layer shipped a one-execution-world check that no shipped composition ran, a ranged read that could return the wrong region of a file, a transfer ceiling no deployment could change, and a test that could not fail.

`packages/bundle/hosted-drive/src/invariant.ts` compares the live `fs.materializationRoot` against the live `sandboxPolicy.resolve().workspaceRoot` and fails when they diverge, and its unit suite proved it throws. No `cordis.patch.yml` in `packages/bundle/` mounted `@deepseek-ai/dsh-invariants` or any `/invariant` companion, so in a real `dsh --profile hosted` the check was never installed. A `--patch` overlay that moved the sandbox fence off the materialization root produced exactly the split world the layer exists to prevent — every spawned process still running against the materialization root while confinement named somewhere else — and nothing observed it. `scripts/package-invariants.ts` enforces export, publication, and build wiring for a companion; it says nothing about composition.

`packages/fs/network-drive-webdav` decided where a ranged answer sat in the file from the body's length: a body no longer than the requested window was treated as the served window and returned whole. A server that ignores `Range` answers 200 with the entire entity, and that entity can be shorter than the requested length, so a read at any offset past zero returned the file's leading bytes with no error. Length cannot separate the two cases; only the status can, and neither the status nor `Content-Range` was read. The seam's `read(path, range, signal?)` accepts any offset and the only current caller passes `offset: 0`, so the defect was latent.

`maxFileBytes: 10485760` sat literal in the shipped patch while every deployment-varying sibling read the environment. Drive latency and per-plan transfer limits differ by deployment, and the value was unreachable from `cordis.yml`.

`hosted-drive.spec.ts` asserted that `sandbox-policy.workspaceRoot` equals `fs-network-drive.materializationRoot` by reading both from the patch file it had just parsed, where both are the identical `!!js process.env.DSH_DRIVE_WORKSPACE` expression. The assertion could only fail by editing that file, and it was the claim the deliverable rested on.

## Decision

**The layer mounts its own invariant.** Runtime invariants stay opt-in repo-wide: [omit-invariants-from-shipped-config](../simplification/2026-08-03-omit-invariants-from-shipped-config.md) decided that the shipped `dsh` trees mount neither the registry nor any companion, so diagnostics cost and `InvariantError` termination are not imposed on ordinary runs. That decision is not reversed here. `packages/bundle/hosted-drive/cordis.patch.yml` inserts the registry with `package_allowlist: ['^@deepseek-ai/dsh-hosted-drive$']` and this package's `/invariant` companion beside it, so a hosted run gains this layer's check and no other package's. The registry moves into the bundle's `dependencies` because a profile installs what the bundle declares; it stays a `peerDependency` and `devDependency` as `verify-package-invariants` requires, the same double listing `@deepseek-ai/dsh-fs-network-drive` already had in this manifest.

The check is narrow on purpose. It stays silent when `ctx.fs` is not the drive-backed provider and when no `sandboxPolicy` is mounted: it owns the agreement between two mounted rows, not the presence of either, and an unfenced tree is the sandbox layer's subject.

**A ranged read is placed by the answer, not by its length.** The provider now requests `details: true`, so `webdav` returns the status and headers beside the body. A 200 body is the whole entity and is cut from the requested offset; a 206 body starts where its `Content-Range` says, and is cut from the difference so a server-widened window still yields the requested region. Any other status, a 206 with no parseable `Content-Range`, and a window served past the requested offset all leave the region unverifiable and raise `DRIVE_IO_ERROR` rather than returning bytes the caller did not ask for. A window starting past the end of the file returns no bytes, which is what the Definition promises when the file ends first.

`webdav` types `getFileContents` as the union of both answer forms because its signature is not overloaded on the flag, so the detailed arm is asserted and then re-checked: `bodyBytes` fails loud on an answer carrying no binary body, which is also what a wrong assertion would produce.

**Both transfer bounds read the environment.** `maxFileBytes` and `requestTimeoutMs` became `!!js Number(process.env.DSH_DRIVE_MAX_FILE_BYTES ?? 10485760)` and `!!js Number(process.env.DSH_DRIVE_REQUEST_TIMEOUT_MS ?? 30000)`, the form `dsh-sdk-minimal` already uses for `DSH_CONTEXT_WINDOW`. The 10 MiB default is a tenth of what `fs-network-drive` allows on local disk because every byte here crosses the network twice; the README documents both defaults.

**The tautology is gone and a real composition replaces it.** The fence/root comparison is deleted from `hosted-drive.spec.ts`, whose module comment now says why and where the honest check lives. `packages/bundle/hosted-drive/tests/invariant-composition.spec.ts` boots the published `cordis.patch.yml` over a base-layer fixture through `loadOverlayPatches` and `boot()` — the launcher's own parser, patch algorithm, Loader, and Include — with only the WebDAV endpoint stubbed, and proves the composed `ctx.fs` serves the drive inside the fenced workspace, that the mounted check passes there, and that a `--patch` overlay moving the fence is rejected at the first observation. Removing the two invariant rows from the patch fails that suite.

The filename carries `invariant` because `scripts/test-invariants.ts` mounts the registry and each package's own companion into every ordinary package-test root: under any other name the mount would pass whether or not the shipped patch carried it. `usesManualInvariantTree` exempts a suite matching `*invariant*.spec.ts`, so this one owns its topology and the patch is the only thing that can install the check.

Plugin names in both layers are rewritten to `cordis:` builtins registered from source. The Loader resolves a bare specifier through Node, which answers with built `lib/`, and a source-plane suite may not load artifacts; `packages/fs/fs-network-drive/tests/composition.spec.ts` uses the same device. Row ids, config, `!!js` expressions, disables, and the patch algorithm stay the shipped ones, and a row naming a plugin with no registered source module fails the rewrite rather than being skipped.

## Alternatives considered

**Mount the registry unfiltered.** The only companion row in the shipped hosted tree is this one, so the allowlist changes nothing today. It states the scope of the opt-in against the repo-wide decision, and keeps a companion added elsewhere later from silently becoming active in a hosted run.

**Check the roots once at startup instead of on `fs/observed`.** A startup check reads the same two values but cannot see a policy that resolves differently later, and `fs/observed` is the path along which a split world does harm: it fires when a read authorizes a later guarded write. The cost is two `realpath` calls per observation, against a network round trip.

**Refuse any non-zero offset the client cannot verify.** That would keep the seam honest without reading the response, but the Definition documents `read` as accepting any offset, and a conforming 206 answer is verifiable — refusing it would deny a capability WebDAV serves.

**Keep the fence/root comparison as a schema check.** Two rows reading one expression in one file is not a relation; the values that must agree are the live ones, and the invariant now compares those.

## Consequences

A hosted profile whose fence and materialization root diverge fails at the first file observation with `invariant violated by "@deepseek-ai/dsh-hosted-drive"`, naming both directories, instead of running as a split world. Every other profile is unchanged: no registry, no companion, no diagnostic cost.

A ranged drive read either returns the requested region or fails; it can no longer return a different one silently. The live caller reads from offset zero and is unaffected either way.

A deployment sets its own transfer ceiling and request deadline from the environment, and the bundle's own patch is the last file that has to change.
