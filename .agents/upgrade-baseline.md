# Upgrade baseline

Captured before raising bun 1.3.11 → 1.4.0 and TypeScript 6.0.3 → 7.0. Both
change what compiles and what resolves, so a regression after them is only
attributable against a recorded starting point.

## Rollback point

Commit `9a77ae05c`, already on `origin/claude/deepseek-harness-audit-0dd6r6`.

A `pre-upgrade-2026-08-29` tag exists locally but is **not on the remote**: the
egress proxy answers `403` to tag pushes while accepting branch pushes. Five
attempts with backoff and an explicit refspec all failed the same way, so the
commit is the rollback point and the tag is a local convenience.

## Toolchain and the dependencies the upgrade puts at risk

| | version |
| --- | --- |
| bun | 1.3.11 |
| node | 22.22.2 |
| typescript | 6.0.3 |
| vite | 8.2.2 |
| vitest | 4.1.11 |
| @stryker-mutator/core | 10.0.0 |
| axe-core | 4.13.0 |
| node-pty | 1.2.0-beta.15 |
| koffi | 3.1.6 |

`node-pty`, `koffi`, and `@deepseek-ai/node-addon-landlock-run` are the native
addons bun 1.4 requires rebuilt: it moves `NODE_MODULE_VERSION` to 147 with a
Node compatibility target of 26.3.

**No source file imports `bun:ffi`.** Bun 1.4 replaces the TinyCC-compiled FFI
with an engine-native one and changes `CString`, and none of that reaches this
repository — `koffi` is a Node N-API addon, not a `bun:ffi` consumer, so it
needs a rebuild rather than a rewrite.

## Lane results at this commit

| Lane | Result |
| --- | --- |
| `bun run test` | 13 failed, 17,453 passed, 89 skipped of 17,555 |
| `bun run test:snapshot` | 1 failed, 106 passed, 2 skipped of 109 |
| `bun run mutation` | 788 detected of 816 = 96.57%, `break` 96.5 |
| `bun run typecheck` | clean |
| `bun run test:docs` | 15 gates pass |
| `bun run hygiene` | recorded here as "1 knip finding, pre-existing"; the lane was in fact failing, and this row was never re-measured at this commit |
| axe | 10 of the 43 packages under `packages/client/` |

The 13 unit failures reproduce identically at the manifest from before the
workspace-resolution fix, so they are not this branch's. Their causes look
environmental — the suite runs as root, so cases that expect a permission or
unreadable-file error get none, and one binds IPv6, which this host lacks — but
that is now proven rather than assumed. Running the same five files as a
non-root user clears every permission-shaped failure — `bash-sandbox` alone goes
from failing to 59 passing — and leaves only the IPv6 listener, which this host
genuinely cannot bind. Running under `su` introduces its own timing failures in
the abort and disconnect tests, so that harness is a diagnostic, not a lane.

The single snapshot failure was `bash-tool`, which needs a usable sandbox
backend. It is now fixed and the lane is green: 107 passed, 2 skipped, none
failing.

Calling that failure environmental was wrong twice over. `musl-tools` installs
here, so the landlock launcher builds — but this kernel does not enforce
Landlock, so that alone was not enough. The error names the alternative, and
`bubblewrap` installs and works here too. CI has been provisioning it all along
through `scripts/prepare-ci-bubblewrap.sh`; the container was missing a
prerequisite the repository already documents, which is not the same thing as
a test that cannot pass.

## After TypeScript 7.0.2 — measured, not carried forward

The table above is the pre-upgrade state. These are the same lanes re-run once
TypeScript 7 had landed, because a lane's result is only current if it was run
in the state being reported.

| Lane | Result |
| --- | --- |
| `bun run typecheck` | 0 errors |
| `bun run build` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run test:docs` | 15 gates pass |
| `bun run test:snapshot` | **107 passed, 2 skipped, 0 failed** |
| `bun run test` | 14 failed, 17,461 passed, 89 skipped of 17,564 |

TypeScript 7 introduced no regression. The unit suite went from 13 failures to
14, and the one added file is `code-runtime-worker-thread`, whose OOM
containment case times out under full-suite concurrency and passes in isolation
with its other 57. The other 13 are the pre-existing set: four permission-shaped
cases that only fail because the suite runs as root, one IPv6 listener this host
cannot bind, and the subagent suites that need external binaries.

## After bun 1.4.0 — measured

| Lane | Result |
| --- | --- |
| `bun install` | 1,094 packages, exit 0 |
| `bun run typecheck` | 0 errors |
| `bun run lint` | exit 0 |
| `bun run test:docs` | 15 gates pass |
| `bun run test:snapshot` | 107 passed, 2 skipped, **0 failed** |
| `bun run test` | 13 failed, 17,462 passed, 89 skipped of 17,564 |
| `bun run mutation` | 788 detected of 816 = 96.57%, `break` 96.5 |

No new failures: the nine failing files are exactly the pre-upgrade set, and
the OOM containment case that timed out under load during the TypeScript 7 run
did not recur.

The mutation row is a fresh run, not the pre-upgrade figure carried forward. Both upgrades change what compiles and what resolves, so the earlier 96.57 could not be reported for this state without re-running Stryker in it. Re-run here, the score is 96.57 again — 788 detected of 816, with the same 28 survivors — so the number is unchanged and now measured where it is claimed.

The ABI change does not reach the product. bun 1.4 reports Node 26.3.0 with
`NODE_MODULE_VERSION` 147, but `dsh` runs under Node 22.22.2 at version 127,
and both native addons load there — bun is the package manager and script
runner, not the runtime. `koffi` and `node-pty` load under Node; the landlock
launcher is built and its binary survived the `node_modules` wipe.

Regenerating the lockfile drifted far more than first reported. Comparing the
pnpm lockfile's resolutions against `bun.lock` gives 111 package entries across
about 74 families, not the fourteen an earlier draft of this file claimed, and
two of them cross a major version: `unbash` 3.0.0 to 4.0.10 and `wsl-utils`
0.3.1 to 1.0.0. Every declared range in the manifests is unchanged except the
upgrades named above, so this is resolution drift inside existing ranges rather
than a dependency change; the drifted versions sampled were 25 to 31 hours old,
so `minimumReleaseAge`'s 24-hour hold applied rather than being bypassed.
`trustedDependencies` still lists the same five packages and their lifecycle
scripts ran. `verify-vendored-links` passes for all nine vendored names.

One drift broke a gate. `knip` went 6.16.1 to 6.32.3, and the newer version
emits configuration hints the pinned one did not; `bun run knip` runs with
`--treat-config-hints-as-errors`, so the hygiene lane failed. The hints were
correct: four `apps/web` `ignoreDependencies` entries and three `ignoreBinaries`
entries no longer matched anything, and removing them removes three exclusions
from the check rather than adding any. The remaining finding was a fixture in
`node-half.client.spec.ts` whose bootstrap factory named its resolver parameter
`require`, so `require('react')` read as a CommonJS import of a package that
file does not use; the parameter is now named for what it resolves. `bun run
hygiene` passes 15 of 15 in that fixed state.

Both CI surfaces follow the pin without editing: the GitHub jobs read
`bun-version-file: package.json`, and the GitLab jobs parse `packageManager`
from the same manifest.

## The application under bun 1.4, run rather than inferred

| Lane | Result |
| --- | --- |
| `bun run dsh --help` | exit 0, no warnings |
| `bun run dsh --profile headless --dump-config` | exit 0, full plugin tree composes |
| `bun run dsh --profile headless "<task>"` | exit 1 at the credential check |
| `bun run test:e2e` | 37 files, 145 passed, 72 skipped, **0 failed** |
| `bun run hygiene` | 15 gates pass |

This container holds no `DEEPSEEK_API_KEY`, so no real model turn ran. What did run is everything up to it: the CLI boots through tsx's ESM hook under Node 22.22.2, the headless profile composes its whole layer stack, and the boot fails at the credential check with the message that names both ways to supply a key — not a stack trace and not a plugin-load error. The keyless recorded-session replay covers the rest of the loop.

`test:e2e` failed one file before this: `packed-install.e2e.ts` fed `npm install` the line `Packed size: 15.41KB`. It took the last line of `bun pm pack` stdout as the tarball path, which was right for the packer it replaced; bun prints the path on its own line and then a summary block. Its `beforeAll` threw, so all three of its cases had been skipped rather than failing. The parse now selects the line by its `.tgz` extension and asserts exactly one, so a future output change fails in the pack step instead of at the install.


## What this container cannot tell us

It runs as root, has no IPv6, and denies tag pushes. Several lanes therefore
report differently here than on the CI matrix, and a green run here is not
evidence of a green run there.
