# Agent Note: Source-only fork launch path

Status: implemented

English | [中文](2026-09-01-source-only-fork-launch-path.zh.md)

## Problem

The root README offered `npx @deepseek-ai/dsh web` as the first supported way to run this repository. That package name lives in the upstream npm scope, which this fork cannot publish to, so the command installs upstream's release and never this checkout — not its source, not its bun 1.4 / TypeScript 7 toolchain, and not its local-build client identity. A reader who followed the first runnable command in the Run section ran a different program than the rest of the README describes.

## Decision

The README gives one launch path: clone this fork, then `bun install`, `bun run build`, `bun run dsh web`. The fork section states that the fork publishes no package of its own and that `npx @deepseek-ai/dsh` fetches the upstream release, so the npm command stays findable as upstream's entry point rather than this repository's. This supersedes the npm launch path in [the product-first README Agent Note](2026-07-22-product-first-root-readme.md); every other part of that decision stands.

Package identity does not move. `apps/cli` keeps the `@deepseek-ai/dsh` name, its public `publishConfig`, and the release families that pack and verify it, because the fork holds its scope, naming convention, and rescope mapping with upstream. Only the README stops presenting a scope this fork does not publish to as a way to run this fork.

## Alternatives considered

**Keep the npm path under a warning.** Rejected because the Run section is what a new reader executes first, and a caveat printed above a runnable command is read after the command has already installed the wrong build.

**Rename the published package to a fork-owned scope.** Rejected because it would rescope every workspace package, contradict the `@deepseek-ai/dsh-*` naming convention and the [rescope mapping](../../../../docs/rescope.md), and commit the fork to a release channel it does not operate.

**Send the npm path to upstream's repository.** Rejected because upstream's README already owns its own install instructions, and a Run section whose first move is to send readers elsewhere is not an entry point for this checkout.

## Consequences

Each README's Run section holds one `### Run from source` subsection, so `#run` and `#run-from-source` both still resolve for the [Web UI guide](../../../../docs/user/guide/index.md), the [model configuration guide](../../../../docs/user/guide/providers.md), the [plugin tutorial](../../../../docs/user/develop/basic/index.md), and the [publish guide](../../../../docs/user/develop/basic/publish.md). Documentation that describes an installed `dsh` binary, such as the CLI reference and the plugin publish guide, still applies to anyone holding upstream's package; it is not a claim about this fork's distribution. Publishing this fork under a name it owns would add that path back and supersede this note rather than edit it.
