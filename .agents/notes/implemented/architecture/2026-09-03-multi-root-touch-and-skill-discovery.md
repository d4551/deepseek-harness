# Agent Note: Multi-root instruction touches and skill discovery

Status: implemented

English | [中文](2026-09-03-multi-root-touch-and-skill-discovery.zh.md)

## Problem

Additional workspace roots reached instruction discovery but stopped at the baseline. `dsh-agent-instructions` walked every recorded root's own project chain when it composed a baseline, and displayed those files by absolute path so a same-named file in another root could not collide with the primary root's. Reconciliation knew nothing about it. Two defects followed.

Reconciliation keyed every directory scope relative to the primary project root and resolved a scope back with `join(projectRoot, directory)`. An additional root's scope directory is absolute, and joining an absolute directory onto the primary project root addresses a path that exists in neither root. Every additional-root instruction was therefore probed at a path that is always absent, so the pre-step that composed the baseline also rendered `Instructions removed:` for the file it had just loaded, in the same message. A session that added a second folder saw its instructions arrive and be retracted before the first request.

Nested discovery was primary-root-only. `descendantDirsBetween` judged a touched path against the session cwd alone, so a successful `read`, `write`, or `edit` inside a second checkout returned no directories and that checkout's nested `AGENTS.md` never loaded. Its containment test also compared the leading characters of a relative path, so a real sibling directory named `..foo` read as an escape — the bug `drivePathOf` in `dsh-fs-network-drive` had already been corrected for.

`dsh-tool-skill` passed `cwd: agent.session.header.cwd` to all three of its registry calls and never consulted the session's roots, so a second checkout's `.dsh/skills` and `.agents/skills` were invisible to the catalog and to the loader.

## Decision

**A workspace root owns the instruction scopes its own files are keyed under, at touch time as well as at baseline.** `probeScopeInstruction` treats an absolute directory scope as the additional-root form discovery produces: it addresses that directory directly and displays the file absolutely. Reconciliation receives the session's additional roots, adds each root's own project chain to its baseline scopes through the shared `workspaceRootChain`, and routes each touched path to the root that owns it. One directory reachable from two roots is probed once, because the two keys address the same candidate and the existing absolute-path dedup keeps the first.

**A touch is routed to the deepest recorded root that contains it**, following `dsh-tool-lsp`'s `sessionWorkspaceRoot`. A root recorded inside another therefore owns its own files and keys them the way its baseline keys them, rather than inheriting the enclosing root's relative form. A relative path routes to the primary root, the base the model writes relative paths against; an absolute path under no recorded root routes to the primary root, where the containment test reports it as outside the workspace and it discovers nothing.

**Containment is a whole-segment test.** `segmentsWithin` splits the relative path and rejects a literal `..` segment, so `..foo` and `...bar` stay the ordinary sibling names they are on disk, and an absolute result — which win32 returns across drive letters — is an escape.

**Skills span every recorded root.** A skill catalog is one session-wide list, not a per-file routing decision, so this follows `dsh-tool-fs-search`'s `searchRoots` rather than the language server's per-file routing: a user who adds a second folder expects its skills to load, and there is no file in hand to route by. `SkillLookupOptions` gains `additionalRoots` beside `cwd`, mirroring the session's own vocabulary and `dsh-agent-instructions`' discovery options. `dsh-skill-filesystem` contributes the project rows of every root, primary first, scanning one project root once when several roots resolve to it. The registry's collect cache keys on the roots as well as the cwd, so two sessions sharing a cwd cannot serve each other a catalog assembled from different roots. `dsh-tool-skill` builds one lookup from `sessionWorkspaceRoots` for the catalog, the loader tool, and user-explicit `/name` invocation.

Source ranks stay per source kind, not per root: root order breaks only the collisions rank leaves tied, so a name present in two roots is won by the primary root. Introducing per-root ranks would make a second root's `.dsh/skills` outrank the primary root's `.agents/skills`, which no consumer asked for.

## Verification

`bun x vitest run packages/context packages/skill` covers the reconciliation of a baseline additional-root file, a nested instruction file discovered by a touch inside an additional root, a changed and a deleted additional-root file, deepest-root routing across three recorded roots, a touch under no recorded root, `..foo` directories in both the primary and an additional root, and a root that respells the session cwd or repeats a directory the primary chain already covers. On the skill side it covers a catalog and a load from a second root, catalog retirement when that root is dropped, one project root scanned once for several roots, a lookup naming only additional roots, and cache isolation between two root sets. Each new test fails when its fix is reverted. Per-file coverage stays at 100% on all four metrics for every changed source file, and `bun run test:snapshot` replays unchanged: no recorded session declares additional workspace roots, so no model-visible output moved.

## Alternatives considered

**Leave reconciliation primary-root-only and record the gap as a limitation.** Rejected: the package README already promised both multi-root discovery and touch-driven refresh, and the immediate retraction of every additional-root instruction was a defect, not a missing feature.

**Give each additional root a scope key relative to its own project root.** Rejected because two roots would then mint the same relative key for different files, which is exactly the collision the absolute display path exists to prevent.

**Call `ctx.skills.list` once per root in `dsh-tool-skill` and merge the results.** Rejected: precedence, per-layer dedup, and catalog caching belong to the registry, and a Consumer-side merge would reimplement all three.

**Rename `SkillLookupOptions.cwd` to a roots array.** Rejected for now: the field is read by the host skill catalog in `dsh-session-controller` and by application tests outside this change's scope, and the additive field already states the primary/additional distinction the session log itself records.

## Consequences

- A provider that reads `SkillLookupOptions.cwd` alone keeps working and simply covers one root; covering the rest is opt-in per provider.
- `reconcileInstructionContext` resolves each additional root's project root per pass. The cost is the same upward marker walk baseline discovery already performs, bounded by root depth, and the additional roots' scope keys are absolute, so re-walking cannot drift a recorded key the way recomputing the primary root would.
- The host skill catalog behind `ctx.remote.skills` (`packages/api/session-controller/src/skill-catalog.ts`) still lists user-invocable skills for the session cwd alone, so the human `/name` catalog in the Web client remains primary-root-only until that call passes the session's roots. Model-facing catalog, loader, and user-explicit invocation inside the agent all cover every root.
