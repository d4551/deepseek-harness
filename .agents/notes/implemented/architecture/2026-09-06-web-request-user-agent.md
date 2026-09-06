# Agent Note: Web requests send one manifest-derived `User-Agent`

Status: implemented

English | [中文](2026-09-06-web-request-user-agent.zh.md)

## Problem

[Mandatory `User-Agent` attribution](2026-06-21-mandatory-app-attribution-headers.md) governs the LLM adapter boundary, and the LLM side reads its version from its own manifest so the header cannot drift from what is published. The web capability never adopted either half.

Five packages each restated the header. `web-search-exa`, `web-search-perplexity`, and `web-search-deepseek` declared `const USER_AGENT = 'deepseek-harness/0.0.1'`, one with the comment "Bump with the package version"; `web-fetch-http` exported `DEFAULT_USER_AGENT` with the same version plus a contact URL, and `web-fetch-playwright` imported that. The repository ships `0.1.2-alpha.1`, so every outbound search and fetch request told Exa, Perplexity, DeepSeek, and every site the fetch provider reads that it was a version released long before. Nothing could notice: the string is a literal in five files and no gate compares it to anything.

## Decision

`@deepseek-ai/dsh-web` owns the identity, since it is the capability every one of those providers already depends on. `WEB_USER_AGENT` is `deepseek-harness/` plus the version read from that package's own manifest through `createRequire`, the same mechanism [`dsh-llm`'s attribution module](../../../../packages/llm/llm/src/attribution.ts) uses and for the same reason. `WEB_FETCH_USER_AGENT` appends the contact URL a crawl policy expects an automated client to publish, and is what the two fetch providers default their configurable `userAgent` to.

`DEFAULT_USER_AGENT` is deleted rather than aliased: the pre-release stance takes the rename and updates every reference, and a second exported name for one value is what let the two fetch providers drift from the three search providers in the first place.

A test asserts `WEB_USER_AGENT` equals the manifest's version and is not the stale literal, so restoring a hardcoded string fails.

## Alternatives considered

**Keep per-package constants and add a gate comparing them.** Rejected: five literals plus a gate is more to maintain than one constant, and the gate would only report drift that the shared constant makes impossible.

**Read the root manifest version.** Rejected: a published package states its own version, and the root manifest is private. The LLM side already resolved this the same way.

**Put the constant in a `packages/util/*` package.** Rejected: the value is the web capability's wire identity and every consumer already depends on `dsh-web`, so a new package would add a dependency edge without removing one.

## Consequences

A new web provider sends the right agent by importing it; there is no version to bump when the release moves. The header now names a real published version, which changes what third-party services see in their logs. A provider that needs a different agent still has its configurable `userAgent` field — the constant is the default, not a fence.
