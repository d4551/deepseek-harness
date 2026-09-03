# Agent Note: the Windows subprocess sources get a coverage floor, and the win32 lane gets its suites back

Status: implemented

English | [中文](2026-09-03-windows-coverage-floor-and-lane-facts.zh.md)

## Problem

Two files in `packages/subprocess/subprocess-local/src` were measured on no platform at all. `windows-inspector.ts` and `windows-job.ts` were excluded from the POSIX coverage lane by literal path, and the win32 lane excluded `packages/subprocess/*` wholesale, so the per-file 100% gate ran on neither one. `windows-job.ts` went further: its entire executable body sat inside `/* v8 ignore start */`, so `createWindowsProcessJob`'s attach-failure cleanup — close the Job, then rethrow — was pinned by no test and measured by no lane. `windows-inspector.ts` measured 37.33% of statements and 64% of functions when the exclusion was lifted, over 315 lines of live decision logic.

The exclusions were stated as platform facts. They were not: `packages/subprocess/win32-process/src/*` is a peer Win32 library that reaches ~100% on POSIX by taking an injected binding table, so "Win32 code cannot be covered" was already false inside the same package group.

The win32 test lane carried the matching defect. Its comment says every entry states the concrete Windows fact that keeps it out; five entries were bare paths — the `subprocess` package's suites plus `local.spec.ts`, `process-inspector.spec.ts`, `spawn.spec.ts`, and `terminal.spec.ts`. Reading them, four are host-independent by construction (`process-inspector.spec.ts` and `terminal.spec.ts` pass an explicit platform to injected internals and a fake PTY; `spawn.spec.ts` and `local.spec.ts` carry `skipIf(win32)` guards, win32-conditional expectations, and command-translation tables written for that lane). The fifth held one real Windows fact, in one assertion.

## Decision

**Both Windows files take an injected seam, exactly like their `win32-process` peers.** `windowsJobFactory(bindings)` composes the Job over a binding-table resolver, and `createWindowsProcessJob` is that composition over the shared `win32ProcessBindings`; composing it opens no library, and a suite drives create/attach/terminate/count/release and the refused-attach cleanup through a stand-in table. `lazyWin32Bindings(load)` takes koffi's library loader as a value, so `bindWin32` — the seven `__stdcall` bindings — runs against a stand-in kernel32 on any host, while the module-level composition passes the real `koffi.load`. `windowsProcessInternals(bindings)` exposes the koffi-backed internals over that resolver, so the Toolhelp32 walk and the `GetProcessTimes`/`WaitForSingleObject` state read execute off Windows against staged rows.

Three `/* v8 ignore */` comments in `windows-inspector.ts` are deleted with their exclusions: the unreadable-snapshot guard, the unreadable-creation-time guard, and the unexpected-wait-state guard are all stageable through the injected table and are now asserted. The struct-size assertion keeps its ignore — a koffi/Windows ABI divergence cannot be staged.

The two path exclusions and the `packages/subprocess/*` sweep are gone. The coverage list's rule is now stated where it lives: a package qualifies only because no suite of its own runs on win32, which is the same list, with the same reasons, as the test lane.

**The five bare lane entries are gone.** `packages/subprocess/subprocess/tests/service.spec.ts` held the only genuine Windows fact: it asserted `env.PATH` on a plain copy of `process.env`, and Windows stores that variable as `Path`, so the copy's case-sensitive lookup misses. The assertion now asks the question Windows semantics actually pose — exactly one key whose upper case is `PATH` — and the suite runs there. The other four are re-included as written.

Two shared helpers in `spawn-support.ts` spawned a `kill` binary that exists only on POSIX, so on the win32 lane `killQuietly` terminated nothing and `processAlive` reported every process dead, which would have made `waitGone` vacuous in the re-included suites. Both now use Node's own signal delivery (`process.kill(pid, 'SIGKILL')` and the zero-signal existence probe), which is defined on every supported host.

**The multi-root dialect test covers every dialect it names.** `sandbox-local`'s `every dialect grants EVERY workspace root…` case asserted bwrap, Landlock, and Seatbelt; the windows-acl runner argv, whose `--workspace` repetition comes from the same `workspaceRoots(policy)` derivation, was exercised with a single root only. It is asserted there now, through `confine()` with an agentless workspace-write policy, so no host ACE is touched.

**The Windows credential and spill READMEs stop claiming a protection that is not there.** `credentials-local` said Windows has no mode to inspect and the confidentiality check is skipped there; it is not — `assertWindowsOwnerOnly` audits the document's DACL and refuses an exposed document, naming the repairing `icacls` command. Both language sides now say that. The write path is the honest gap: `{ mode: 0o600, dirMode: 0o700 }` in `credentials-local` and `0o700`/`0o600` in `spill-local` are ignored by Windows, `win32-process/src/file-security.ts` is audit-only with no set-DACL primitive, and a document therefore inherits its parent directory's access-control list and is refused on the next read rather than created owner-only. That is recorded under `## Known Limitations and Deferred Work` in both languages for both packages instead of being implied away.

## Alternatives considered

**Keep a narrow POSIX exclusion for the koffi loader only.** Rejected: the loader is one `koffi.load('kernel32.dll')` call, and passing the loader as a value moves it behind a seam the suite can drive. An exclusion there would have left the seven binding declarations — the names and stdcall signatures a typo breaks — unmeasured for no gain.

**Cover the Windows-only lines on the win32 lane and exempt them on Linux.** Rejected for these two files: the per-file gate runs on both lanes independently, so a line covered on only one still needs an exclusion on the other, which is the arrangement that hid them. It remains the right answer for `sandbox-windows-acl`, whose entry points open a restricted token rather than a table.

**Leave the four unexamined lane entries out and document a reason.** Rejected: three of the four never touch the host at all, so any reason written for them would have been invented. A suite that is merely untested on Windows is re-included, and what breaks is fixed or named.

**Implement owner-only creation on Windows.** Deferred: it needs a set-DACL primitive (`SetNamedSecurityInfo` or a `SECURITY_ATTRIBUTES` descriptor at create time) that `win32-process` does not have, and it can be verified only on a Windows host. Recording the exposure is what this change can prove.

## Consequences

`packages/subprocess` now meets the per-file 100% gate from its own suites alone: 18 measured files, 1136/1136 statements, 587/587 branches, 233/233 functions, 987/987 lines. `windows-inspector.ts` is 82/82 statements and 31/31 branches; `windows-job.ts` is 13/13 statements and 5/5 functions, where it previously measured one statement and zero functions. Closing the group also took four adjacent gaps found while measuring: the service's `ctx.logger.warn` sink, `spawnSubprocess`'s default `process.emitWarning` sink, the taskkill report that carries a status and no spawn error, and the ACL walk's truncated-trustee guard.

The win32 coverage lane now gates every `packages/subprocess` source, and the win32 test lane runs every subprocess suite. Both are CI-only signals: this change was verified on macOS, and a per-file gap that only the Windows lane can see will surface there rather than being pre-excluded. That visibility is the point of removing the sweep; a file that genuinely cannot execute off Windows earns a per-file entry with its reason, never a package glob.
