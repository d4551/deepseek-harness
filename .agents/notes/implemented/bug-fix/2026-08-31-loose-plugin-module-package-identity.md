# Agent Note: Loose plugin modules carry no package identity

Status: implemented

English | [中文](2026-08-31-loose-plugin-module-package-identity.zh.md)

## Problem

`dsh_plugin_packages` is prepared on every official DeepSeek request before dispatch, and a rejection inside preparation fails the whole turn with `REQUEST_EXTENSION`. Relative and absolute plugin modules resolve their identity by walking to the nearest owning `package.json`. A plugin mounted from a profile patch layer (`name: './model-fallback.js'`) walks to the manifest `initProfile` writes: `{ name: "dsh-profile-<dir>", private: true, dependencies, dsh }`, which carries no `version` because npm requires one only for publication. The resolver accepted an absent `name` as a loose-module marker but demanded a `version` from every named manifest, so a profile that mounts any relative module made every official DeepSeek request fail before HTTP, on every turn, until the manifest was hand-edited.

## Decision

`plugin-package-inventory-deepseek` reports an identity only for a manifest declaring both a non-empty `name` and a non-empty `version`. A manifest reached by walking up from a relative or absolute module marks a loose module when either field is missing: profile scaffolds, workspace roots, and other private manifests own directories without naming a publishable package, so the module contributes no identity and the request proceeds. A manifest reached by resolving a bare package name is still held to both fields, because Node resolved it out of an installed package tree; a missing field there fails request preparation as before. This is the rule the package README already stated as its loose-module limitation.

Coverage moves with the rule: the malformed-metadata rejection is pinned through a bare `node_modules` package, and a profile-shaped manifest with a name and no version is pinned as omitted beside a versioned sibling that still reports.

## Alternatives considered

**Write a `version` into generated profile manifests.** Rejected because it repairs no existing profile directory, and it makes each profile report itself (`dsh-profile-web@0.0.0`) as an active plugin package when the directory is local scaffolding rather than a package.

**Treat only `private: true` manifests as loose.** Rejected because publication intent does not decide whether a manifest identifies a package: every workspace package here is private and versioned, and would need a second exception.

**Omit the field whenever any entry fails to resolve.** Rejected because a bare package name resolved through a package tree was installed with both fields; a missing one there is misconfiguration that stays loud.

**Let the adapter drop failed extension fields and dispatch anyway.** Rejected because preparation is one fail-closed transaction shared with `dsh_session_log`, whose acceptance watermark must not advance for a request the provider never received.

## Consequences

A plugin module living beside a versionless manifest is invisible to the inventory rather than fatal to the session, and the inventory reports only entries whose owning package is genuinely identifiable. The loud rejection narrows to bare package specifiers, where the manifest is an installed package's own. Existing profiles recover without touching `~/.dsh`. Preparation failures that remain now name their reason in the `REQUEST_EXTENSION` message, so the session log carries something an operator can act on.
