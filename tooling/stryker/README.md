---
description: "Rebuild and verify the maintained Stryker source distribution, dependency ownership, and native process regression checks."
---

# Maintained Stryker distribution

English | [中文](README.zh.md)

## Summary

Rebuild the mutation runner from verified upstream sources and inspect every local source change before installing its generated packages. This contributor reference owns reconstruction and package evidence; repository mutation thresholds remain independently enforced.

## Table of Contents

- [Rebuild and check](#rebuild-and-check)
- [Source and dependency ownership](#source-and-dependency-ownership)
- [Verification limits](#verification-limits)
- [Dev Note](#dev-note)

-----



## Rebuild and check

Use the exact Bun and Node releases in [toolchain.json](provenance/toolchain.json), Git, network access to the pinned official archives and registry, and Playwright's installed Chromium. Run from the repository root:

```sh
bun tooling/stryker/rebuild.mjs check
bun test tooling/stryker/src/integrity.test.mjs
node tooling/stryker/verify-installed.mjs
```

The check reconstructs a fresh directory under the operating system's temporary directory, installs the [frozen build dependency graph](build/bun.lock), compiles complete instrumenter, core and runner sources with native TypeScript, and runs the maintained native regressions. It rejects archive integrity failures, unsuccessful commands, changed package bytes, and changed file inventories. It prints the retained directory containing complete command and browser logs on both success and failure. Remove that directory after reviewing its evidence.

After reviewing changes to the readable [source and regression patches](patches/), regenerate the artifacts and independently check them:

```sh
bun tooling/stryker/rebuild.mjs rebuild
bun tooling/stryker/rebuild.mjs check
```

`rebuild` writes artifacts only after compilation and regressions succeed. Review the source patches, build manifest and lock, generated instrumenter and runner patches, complete [packed-file inventory](artifacts/inventory.json), and [artifact hashes](artifacts/hashes.json) together. Do not edit emitted JavaScript, declarations, source maps, or the tarball by hand.

Generated patches retain two context lines and serialize empty context lines without a leading space. Generation rejects whitespace errors with Git's native check. The integrity tests apply the generated patch and compare the resulting source bytes.

-----



## Source and dependency ownership

[upstream.json](provenance/upstream.json) records official npm archive integrity, source commit, source archive digest, and exact additional build inputs. Reconstruction keeps the published API package intact, deletes published instrumenter, core and runner outputs, and compiles their maintained TypeScript. The upstream source archive supplies original compiler settings, runner schema and typings, and the real unpublished test-helper workspace. [upstream-build.patch](patches/upstream-build.patch) records the strict standalone build configuration; source discovery remains complete. The instrumenter compiles first so core resolves its generated declarations.

Core owns `jsonc-parser` in its runtime dependencies. Its [local tarball](artifacts/stryker-core-10.0.0-ts7-source-repair.tgz) supplies package metadata before Bun resolves dependencies. Bun's package patch mechanism does not add that dependency to the resolved graph; a root declaration cannot replace core ownership. The generated [instrumenter patch](artifacts/@stryker-mutator%2Finstrumenter@10.0.0.patch) and [runner patch](artifacts/@stryker-mutator%2Fvitest-runner@10.0.0.patch) each include source and compiler output together. The [build manifest](build/package.json) separately owns reconstruction and regression dependencies, including the instrumenter's `estree-walker` typing input.

The root manifest installs this core archive and both generated patches. [Installed-package verification](verify-installed.mjs) checks every package file against the generated inventory, archive and patch digests, shared API identity, CLI entry point, and core's parser dependency. It also validates Bun's empty patch markers against the patch-derived identifier. The ordinary [distribution tests](../../scripts/stryker-distribution.spec.ts) run this verification and the native mutation accounting cases through the root installation.

The [core source patch](patches/core-source.patch) owns static mutation activation, strict JSONC configuration parsing and preserved reporter injection types. The [runner source patch](patches/vitest-runner-source.patch) owns configured native pools, child activation transport, infrastructure error classification and disposal. The [instrumenter source patch](patches/instrumenter-source.patch) retains call and throw removal candidates even when their arguments also produce mutations, and uses Babel 8's built-in `import.meta` parser support. All three packages retain their upstream Apache-2.0 license files inside package payloads; the upstream test-helper workspace declares ISC and is used only during building and testing. These distributions require explicit disclosure in the repository's [generated notices](../../THIRD_PARTY_NOTICES.md).

Primary maintenance references are [Bun installation](https://bun.com/docs/pm/cli/install), [Bun package archives](https://bun.com/docs/pm/cli/pm#pack), [Bun archive extraction](https://bun.com/docs/runtime/archive), [Vitest 5.0.1](https://github.com/vitest-dev/vitest/releases/tag/v5.0.1), and [jsonc-parser](https://github.com/microsoft/node-jsonc-parser#api).

-----



## Verification limits

The maintained regressions exercise real forks, changing the working directory, JavaScript and TypeScript children, startup and collection errors, browser and React execution, in-process per-test coverage, static initialization, timeout cleanup and a subsequent original baseline. The [mutation accounting tests](runtime/mutation-accounting.test.mjs) require both call/throw removal and argument mutations, then execute every emitted candidate in a native child. They verify this distribution's behavior; their small mutation fixtures do not measure repository mutation acceptance.

Child processes inherit the active mutation identifier, but they do not return coverage or hit counters. Child suites require all tests with `coverageAnalysis: off`; explicitly constructed child environments that omit the identifier remain unchanged. Native Windows, VM pools and older Vitest releases are unverified.

Browser logs retain two framework warning categories: Vitest's interceptor returns a Vite-specific `configureServer` hook from `applyToEnvironment`, and Vite cannot analyze a dynamic import in its optimized module runner. Passing regressions do not certify warning-free browser execution. Review these diagnostics separately from mutation classifications.



## Dev Note

None.
