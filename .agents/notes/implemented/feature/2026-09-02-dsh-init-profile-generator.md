# Agent Note: `dsh init` generates a profile's config files

Status: implemented

English | [中文](2026-09-02-dsh-init-profile-generator.zh.md)

## Problem

A profile is three files under `$DSH_HOME/profiles/<name>` — the manifest carrying its bundle layer list and reload lifecycle, the user patch layer, and the bun install settings out-of-tree plugins resolve their peers through. Only the five shipped names generated them: `loadProfile` matched `PROFILE_TEMPLATES` and called `initProfile` on first boot. Every other name failed, and the diagnostic's only remedy was `dsh plugin --profile <name> add <package>`, which creates a profile as a side effect of installing something into it. A user who wanted a base-only profile to patch had no command to run, had to name a package they did not want, and needed bun on `PATH` to get three small files written. Nothing generated the config at the moment the run needed it.

## Decision

`dsh init --profile <name>` ([`apps/cli/src/init.ts`](../../../../apps/cli/src/init.ts)) writes those files and exits without booting. A shipped name reproduces exactly what its first boot would have created; any other name starts from `@deepseek-ai/dsh-base` with `patchReload: live`. Repeatable `--bundle <package>` replaces the layer list in argv order, and `assertBundlesUsable` rejects a layer that does not resolve or declares no `dsh.bundle` before anything is written, so the generator cannot emit a manifest whose next boot fails on its own layers. Generation reuses `initProfile`, which writes each file only when absent: a rerun reports the existing profile, keeps its edits, restores a missing `bunfig.toml`, and says `--bundle` was ignored rather than rewriting a layer list the user may have hand-edited.

The boot path still refuses to generate. `missingProfileMessage` ([`packages/boot/app-boot/src/profile.ts`](../../../../packages/boot/app-boot/src/profile.ts)) replaces the old one-line hint with the shipped names, the profiles `listProfileNames` finds already initialized under `$DSH_HOME/profiles`, and the `dsh init --profile <name>` command that creates the missing one. Listing what this home can boot is what makes a typo visible; creating the profile instead would turn a misspelled shipped name into an empty tree that boots and does nothing.

## Alternatives considered

**Generate any missing profile during the boot itself.** Rejected: it is the one option that breaks a name the user already knows. `dsh --profile healdess` would silently manufacture a base-only profile and boot an agent with none of headless's rows, and the failure would surface as absent behavior rather than a named error. The repository rule that misconfiguration fails loud and never silently skips a missing referent exists for this case.

**Prompt before generating during the boot.** Rejected: `headless`, `sdk`, `sdk-minimal`, and `acp` have no interactive surface, so the prompt needs a non-interactive answer, and the only available answer is the silent generation above. A confirmation that cannot be asked half the time is not a confirmation.

**Keep `dsh plugin --profile <name> add <package>` as the only path.** Rejected: it couples creating a profile to installing into it and requires bun on `PATH`. `dsh plugin` still initializes on first use, so nothing was taken away; the generator is the path that does not demand a package the user has no reason to pick.

**Suggest a near name by edit distance instead of listing.** Rejected: a distance function is owned code and its own tests in exchange for a guess. The real list is deterministic, shows the typo against the correct spelling just as clearly, and additionally answers what this home can boot — which a suggestion does not.

## Consequences

Creating a profile is one command that names no package, and the boot that discovers the gap prints the command that closes it, so the generator is reachable at the moment the run fails. The boot path keeps its loud failure: nothing about the run's behavior changed except the text of one error. The cost is a fourth CLI mode to keep documented alongside the other three, and a second place that resolves a bundle name (`assertBundlesUsable` calls `resolveBundleDir`, the same two-anchor resolver a boot uses) — a `--bundle` check that would otherwise be deferred to a boot the user has not run yet. Explicit layers are validated but template and default layers are not: a boot that cannot resolve those describes a broken installation, not a bad argument, and re-checking them here would move that diagnosis away from the boot that owns it. Seven behavior tests pin generation, template reproduction, layer order, the idempotent rerun, the rejected layers, and the invalid profile name; the diagnostic has its own test in the app-boot profile suite.
