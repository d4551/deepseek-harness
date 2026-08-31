# Agent Note: Canonical realpath targets for profile fallback links

Status: implemented

English | [中文](2026-08-31-canonical-profile-fallback-link-targets.zh.md)

## Problem

`healProfilesModuleFallback` resolved each installation dependency with `packageDirFromAnchor` and stored the literal probe path as the `$DSH_HOME/profiles/node_modules` symlink target. In a bun-workspace checkout a dependency can resolve at a nested `node_modules` entry reached through a symlinked parent package, where the final hop is a relative link that resolves only from the physical parent directory. Node's resolver follows the whole chain, but a consumer that walks links without following intermediate symlinks — the web profile's `assert-single-dsh-tools` fail-closed detector, whose lexical walk works around bun's `realpathSync` throwing `ENOENT` on dangling links — classifies such a target as dangling. A `bun install` that reshuffles the nested layout then re-heals the symlink to a fresh literal nested path, and `dsh web` fails closed with "the host tree has no copy" even though host and profile copies resolve to the same physical package.

## Decision

`resolveModuleFallbackEntries` canonicalizes the install anchor and every probed dependency directory with `realpathSync.native` (`canonicalPackageDir`) before storing it as the fallback symlink target and BFS anchor, so packaged-executable proxy targets record canonical file URLs as well. This matches `dependencyClosure`, which already canonicalizes its anchors for profile-owned links. The [profile-plugin-bundles decision](../architecture/2026-08-05-profile-plugin-bundles.md) keeps owning the fallback's two-anchor resolution and the [unlink decision](2026-08-12-unlink-stale-profile-fallback-links.md) the removal primitive; this note owns the stored-target form.

## Alternatives considered

**Keep the literal probe path.** Node's parent-walk resolves it at runtime, but every consumer that compares or walks stored targets without following intermediate symlinks misreads it, and each install-layout change rewrites targets whose physical identity did not move.

**Fix consumers to resolve intermediate symlinks.** The fail-closed detector is installed profile state outside this repository, and its lexical walk exists because bun's `realpathSync` throws on dangling links; the harness cannot require every consumer of a stored path to resolve chains the filesystem already canonicalizes.

**Canonicalize inside `packageDirFromAnchor`.** Would also change `resolveBundleDir` results, whose layer directories feed patch loading and loader imports; the stored-fallback-target contract belongs to the heal, so the canonicalization lives there.

## Consequences

Fallback links hold one canonical absolute path per installation dependency, stable across `bun install` layout reshuffles; the first launch after this change re-points existing literal links once, and `moduleFallbackEntryCurrent`'s string comparison then compares canonical paths. On platforms whose temporary directories are symlinked (macOS `/var` → `/private/var`) stored link content changes, never resolution. The `links canonical realpaths when a dependency resolves through a symlinked workspace layout` test pins the symlinked-parent-plus-relative-hop fixture.
