# Agent Note: Manual same-major registry bump excluding majors and vendor

Status: implemented

English | [中文](2026-08-30-manual-same-major-dependency-bump.zh.md)

## Problem

Declared registry pins lag the latest same-major versions, and two file watchers still depend on chokidar 4 while `skill-filesystem` and `webworker-runtime` already depend on chokidar 5. Dependabot proposes aged updates on a weekly cooldown and does not cover this kind of reviewed manual alignment. A blanket `bun update --latest` would also take major versions that need their own migrations.

## Decision

The workspace keeps latest same-major pins for the packages listed below, and it leaves majors, vendored sources, and patched packages on the versions they already use.

Same-major pins:

| Package | Pin |
|---|---|
| `knip` | `^6.33.0` |
| `oxlint` | `1.80.0` |
| `mermaid` | `11.17.2` (root and website) |
| `@yarnpkg/cli-dist` | `4.18.0` |
| `ws` | `8.21.3` (exact or `^8.21.3` where the manifest already used a caret) |
| `cytoscape` | `3.34.2` |
| `dayjs` | `1.11.23` |
| `use-sync-external-store` | `1.6.0` |
| `chokidar` | `^5.0.0` in `credentials-local` and `settings-file` |

`credentials-local` and `settings-file` keep the named `watch` export, `ignoreInitial`, `awaitWriteFinish`, and `watcher.close()`. Vendor `hmr` stays on chokidar `^4.0.3` because vendored manifests move only through [vendor/README.md](../../../../vendor/README.md).

These majors stay on their current majors until a dedicated migration: React 19, `@types/react` 19, `@vitejs/plugin-react` 6, Vite 8 for `apps/web` and the VitePress site, js-yaml 5, jsdom 30, immer 11, zustand 5, katex 0.18, eventsource-parser 4, `typescript-language-server` 6, `@types/node` 26 at the root (the engine floor is still Node 22), `@types/picomatch` 4, e2b 2.46, OpenTelemetry 0.221, and the Anthropic/Codex 0.x jumps. `node-pty` and `@stryker-mutator/core` stay on their patched versions. Zod stays at 4.4.3 until `minimumReleaseAge` lets a newer 4.x through.

Manual updates remain allowed under the [Dependabot 30-day cooldown decision](2026-07-27-dependabot-version-updates.md); that cooldown applies to the automated weekly path, not to an explicitly reviewed bump.

## Alternatives considered

**`bun update --latest` across every workspace.** Rejected because it would take React 19, js-yaml 5, Vite 8 on VitePress, and other majors in one lockfile rewrite, and it would rewrite vendored manifests.

**Leave chokidar 4 on the two watchers.** Rejected because the repository already runs chokidar 5 in `skill-filesystem` and `webworker-runtime`; keeping two majors for the same watcher API is accidental drift, not a recorded split.

**Bump e2b, OpenTelemetry, and the Anthropic/Codex 0.x packages with the same-major pins.** Rejected because those SDKs change call sites and provider contracts; they need their own tests, not a pin rewrite.

## Consequences

Oxlint 1.80 can emit new diagnostics the 1.76 pin did not. Knip 6.33 can emit new configuration hints; `knip --treat-config-hints-as-errors` still fails the hygiene lane on those. A later major bump still needs its own Agent Note and tests rather than riding this pin set.
