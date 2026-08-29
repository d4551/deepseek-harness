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
| `bun run hygiene` | 1 knip finding, pre-existing |
| axe | 10 of the 43 packages under `packages/client/` |

The 13 unit failures reproduce identically at the manifest from before the
workspace-resolution fix, so they are not this branch's. Their causes look
environmental — the suite runs as root, so cases that expect a permission or
unreadable-file error get none, and one binds IPv6, which this host lacks — but
that has not been proven by running them as a non-root user, which is the first
thing the upgrade phase does rather than assume.

The single snapshot failure is `bash-tool`, which needs a usable sandbox
backend. `musl-tools` is installable here, so the landlock launcher can be
built and that failure is expected to clear.

## What this container cannot tell us

It runs as root, has no IPv6, and denies tag pushes. Several lanes therefore
report differently here than on the CI matrix, and a green run here is not
evidence of a green run there.
