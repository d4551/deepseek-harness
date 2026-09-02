# Agent Note: Windows parity for shared platform behavior

Status: implemented

English | [中文](2026-09-03-windows-parity-for-shared-platform-behavior.zh.md)

## Problem

Windows support was structurally unfalsifiable. Whole packages sat in the Windows test-lane exclusion list as bare paths with no stated reason, so `packages/hooks/*` — a bridge that is not bash-specific — had zero Windows coverage, and `packages/terminal/terminal-bash` was excluded even though it owns the `pwsh` PTY dialect the shipped Windows presets mount. Windows coverage could stay red beside a green verdict, and no job in the verdict gate ran the win32-only suites that prove real ACL confinement.

Underneath that, several shared components answered Windows-specific questions with a POSIX assumption or with nothing at all. `assertOwnerOnly` returned early on win32, so a credentials document any local account could read was served without complaint; the spill sweep's ownership, world-writable, and sticky-bit checks all returned "safe" there. Three atomic-write paths skipped the directory fsync on win32 with no Windows peer, so a published name was not crash-durable. The local subprocess provider owned Windows process trees through `taskkill /T /F` whose outcome was explicitly discarded and a liveness probe that degraded to the direct child. `resolveExecutable` asked for `X_OK`, which Node maps to `F_OK` on Windows, making the "is executable" check a silent no-op. The local sandbox returned a sole platform candidate unprobed, so a broken Windows backend first surfaced as exit 127 mid-task.

## Decision

**Every Windows test-lane exclusion names its platform fact.** [vitest.config.ts](../../../../vitest.config.ts) keeps only the four packages whose subject is a POSIX program — the bash executor, its sandboxed form, the bash tool Consumer, and the POSIX runner chain — each with the concrete reason inline and its Windows peer named. `packages/hooks/*` and `packages/terminal/terminal-bash` are gone from the list: both now run on Windows.

**Hook programs are Node programs, and the hook shell is the host's.** The bridge suites wrote `#!/usr/bin/env bash` scripts, which made them a POSIX-only test of a platform-neutral bridge. [`hook-program.ts`](../../../../packages/hooks/hook-protocol/tests/hook-program.ts) writes each hook as a `.mjs` file invoked as `node "<path>"` — a command line bash and PowerShell parse identically — with a small prelude so bodies state what the hook does instead of shell syntax, and mounts `PwshLocalExecutor` on Windows where the POSIX suites mounted `LocalBashExecutor`. [`pwsh-shell.spec.ts`](../../../../packages/hooks/hook-protocol/tests/pwsh-shell.spec.ts) drives `runHook` through a real PowerShell `ctx.shell` for the stdin payload, the structured stdout decode, the blocking exit code with its stderr reason, and the bridge's trusted environment entries. The pwsh PTY dialect suite is likewise never skipped on Windows: PowerShell ships with the operating system, so a failing probe there is a broken host and fails loudly at the first spawn.

**The pull-request verdict includes Windows coverage and the win32-only confinement suites.** `windows-coverage` joins `all checks passed`, and `windows-native-tests` — already in the gate — runs the ACL-sandbox suites, the `pwsh-sandbox` end-to-end confinement suite through the e2e config, and the new win32-only credentials, spill, and pwsh-hook suites. The [dual Wine and native Windows CI note](../process/2026-08-08-native-windows-pull-request-ci.md) owns the topology and records why `windows-observational` stays out.

**A Windows confidentiality question is put to the DACL.** [`file-security.ts`](../../../../packages/subprocess/win32-process/src/file-security.ts) reads one path's owner and DACL through `GetFileSecurityW` on the shared Win32 binding table, then decides purely over the returned bytes: an allow entry reaching the requested access whose trustee is neither the owner nor an administrative account is exposure, a missing DACL is total exposure, and deny entries are ignored so the audit errs toward reporting exposure rather than missing it. `credentials-local` refuses a document another account can read with an `icacls` remediation, and `spill-local` asks the same machinery whether a root is writable by others and whether any ancestor can replace it. The ancestor mask deliberately omits creation rights: the Windows volume root grants every user "create folders / append data" while refusing to delete another account's entry, which is what the POSIX sticky bit encodes for `/tmp`.

**A published name is durable on Windows.** [`win32.ts`](../../../../packages/util/atomic-write/src/win32.ts) owns the durable-namespace primitives — `MoveFileExW` with `MOVEFILE_WRITE_THROUGH`, plus `MOVEFILE_REPLACE_EXISTING` for atomic replacement — behind the package's `./win32` subpath export. `dsh-atomic-write` commits its own writes through it, `storage-json` replaces unit files through it, `attachment-local` creates every directory and publishes every content-addressed object through it, and `session-persistence-jsonl` consumes the same primitives instead of its own copy.

**Windows process trees are owned by a Job object.** [`job.ts`](../../../../packages/subprocess/win32-process/src/job.ts) creates a kill-on-close Job and assigns an already-spawned process to it, terminates every member at once, and reports the kernel's assigned-process count. `subprocess-local` attaches the leader in the same turn as the spawn, so every descendant inherits membership; whole-tree liveness is that count rather than the direct child's exit; and the Job handle is released only once the tree is confirmed gone. `taskkill` remains the fallback for a Job the kernel refuses, and its outcome is now checked: a status other than success or process-not-found, a spawn failure, or a Job call that throws is reported through the provider's warning sink instead of being discarded.

**`resolveExecutable` checks what it claims on Windows.** The POSIX arm keeps `access(X_OK)`; the Windows arm requires the candidate's extension to be in `PATHEXT`, the same rule the bare-name candidate expansion already applies.

**Every sandbox candidate is probed, a chain of one included.** `chainVerdict` no longer returns a sole candidate unprobed, so a Windows or darwin backend that cannot run fails at composition with `SandboxUnavailableError` rather than at the first confined command.

## Testing

Platform-specific behavior is exercised on every host wherever the decision — not the syscall — is the subject: the DACL audit parses descriptors assembled byte for byte, `readFileSecurity` and every Job primitive take an injected binding table, the durable-move consumers drive a stubbed primitive under a mocked platform, and the Job-owned tree is driven by an injected Job under an injected platform. Only the four cases that need a real NTFS ACL or a real PowerShell — the credentials and spill confidentiality suites, the pwsh hook suite, and the ACL confinement suites — are win32-gated, and each of them runs in `windows-native-tests`, a dependency of the pull-request verdict.

## Alternatives considered

**Leave `packages/hooks/*` excluded and cover the bridge on Linux alone.** The bridge's Windows behavior is the shell it runs the configured command through, which Linux cannot exercise at all. The exclusion was not a statement about hooks; it was the absence of one.

**Translate the suites' bash hooks to PowerShell.** That doubles every fixture and pins each suite to a dialect the product does not care about. A Node program is a hook the bridge treats identically on both hosts, and the suites read as hook behavior rather than shell text.

**Keep a second Win32 binding table for the security calls.** `extendWin32ProcessBindings` already exists so a caller can add its own API family to the one loaded table; a second `koffi.load` per consumer would multiply the ABI surface with no owner.

**Give each durable-write package its own `MoveFileExW` module.** `session-persistence-jsonl` already had one, and copying it is what the duplication gate exists to catch. One owner in the atomic-write package, reached through a real subpath export, keeps the flag choice and the errno mapping in a single place.

**Create the Job by spawning the process inside it.** `spawnInheritedJobProcess` does exactly that, but through `CreateProcessAsUserW` with a restricted token that a Node `child_process.spawn` path does not have. Assigning the already-spawned leader before it can execute keeps the whole tree covered without duplicating process creation.

**Keep `taskkill` as the only Windows termination path and merely check its status.** A checked status still cannot see a grandchild whose parent already exited, and cannot answer whether the tree is alive. The Job answers both, and taskkill stays only for the case where the kernel refuses one.

**Approximate the Windows confidentiality check with a well-known-SID denylist.** Refusing only Everyone, Authenticated Users, and Users would pass a document explicitly shared with one other account. Reading the owner from the descriptor makes the check an allowlist, which is what the POSIX peer already is.

## Consequences

Windows regressions now fail pull requests: Windows coverage and the win32-only confinement suites gate the branch, and a package excluded from the Windows lane must state the platform fact that keeps it out. The hooks bridge and the pwsh PTY dialect are exercised on the platform whose shell they exist to support.

Three previously silent Windows behaviors now refuse work that used to proceed. A credentials document whose DACL admits another account fails at load instead of serving secrets; a spill root or ancestor that another account can write to or replace is skipped with a warning instead of swept; and an absolute command whose extension is not in `PATHEXT` is rejected instead of being handed to a spawn that would fail later. Each refusal names the remediation.

`dsh-atomic-write` is no longer dependency-free: it carries `koffi` for the durable-namespace primitive, and `credentials-local`, `spill-local`, and `subprocess-local` depend on `dsh-win32-process` for the security and Job families. The Win32 libraries still load lazily, so no other platform opens them.
