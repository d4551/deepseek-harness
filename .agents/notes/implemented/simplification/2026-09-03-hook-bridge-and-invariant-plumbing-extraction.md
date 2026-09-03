# Agent Note: Hook bridge plumbing moved into the protocol library

Status: implemented

English | [中文](2026-09-03-hook-bridge-and-invariant-plumbing-extraction.zh.md)

## Problem

Removing `.jscpd.json`'s in-file suppression ([the marker note](2026-09-03-duplication-suppression-that-suppressed-nothing.md)) surfaced six clones between the two hook bridges: five in `hooks-claude-code/src/index.ts` against `hooks-codex/src/index.ts` and one between their `config.ts` files.

The clones were the whole bridge apart from its dialect: the import block, the `runPoint` body that matches a group, appends `hook/invoked`, runs the command, warns about unhonored fields, appends `hook/result`, and merges; `contextFrom` and `prependContext`; `lastTurn` and `blocksToText`; the `session_id`/`transcript_path`/`cwd`/`hook_event_name` base fields Codex copied from Claude Code; the detached-run tracker and its drain effect; the config read, skip warnings, and abort-registration-on-failure rule; and the four decision mappings on `agent/pre-step`, `tools/pre-execute`, `tools/post-execute`, and `agent/turn-stopping`, including the rule that a context-only outcome delegates instead of vetoing.

Three comments argued for keeping it that way. `hooks-codex/src/index.ts` said "Each dialect bridge keeps its complete dependency list visible at the entry point", "Execution and decision mapping remain in each bridge so dialect differences stay explicit at their owning extension point", and "sharing them would pull bridge-only agent/LLM dependencies into hook-protocol". The first two describe what the reader gets for the price; neither is a contract, and the price was that every fix to the merge-and-log path had to be made twice, in two files whose text had already drifted (the CC copy warns about `updatedInput`, the Codex copy converts plain stdout to context). The third is true and is the actual cost: `dsh-hook-protocol` had to acquire the `dsh-agent`, `dsh-llm`, `dsh-tools`, and `dsh-session-persistence` peers. Both bridges already declared all four, so no new edge crosses the package graph, and both bridges shed the imports they no longer make.

## Decision

`@deepseek-ai/dsh-hook-protocol` owns the whole bridge apart from the dialect, in four new modules re-exported from its published `index.ts`.

`payload.ts` owns `lastTurn`, `blocksToText`, and `hookEventFields`, the four identity fields both dialects carry; the absent-transcript spelling is a parameter because Claude Code writes `''` and Codex writes `null`.

`config.ts` owns `parseHookGroups`, the event/group/hook skeleton with matcher validation and the rule that `UserPromptSubmit` and `Stop` carry no matcher subject in either dialect, plus `loadHookGroups` and `assertPositiveInteger`. Each dialect supplies only its supported events, its matcher mode, and one callback converting a raw hook entry — where Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` and Codex rejects `async: true` and accepts the `timeoutSec` alias.

`bridge.ts` owns `startHookBridge`: it resolves the two limits, validates them before the config load so a bad limit cannot hide behind the load's early return, reads the config once, registers the detached drain disposer only for a bridge that will run hooks, and returns the `HookBridge` surface — or `undefined`, which the bridge reads as "register nothing". `HookBridgeOptions` states what a dialect decides: `dialect`, `plugin`, `trailingNewline`, the `unhonored` fields it warns about, and an optional `env`.

`extension-points.ts` owns one registrar per shared extension point. Each takes the dialect's payload builder and only the capability that point varies by: `plainStdoutAsContext` on the two context-bearing points, `honorAsk` on `PreToolUse`. Claude Code's `subagent/start` and `subagent/end` stay in that bridge and drive `HookBridge` directly, since Codex has no such points.

Each bridge keeps its payload field set, its config entry conversion, its `Config` schema, and its capability declaration. Model-visible behavior is unchanged: warning text, the `<dialect>:<point>:<n>` handler id, and every decision mapping are reproduced verbatim, and the counter is still module-level so ids stay unique across mounts.

## Alternatives considered

**One `registerHookBridge` taking every point at once.** Rejected: the union of five points' options is a flag bag in which `honorAsk` and `plainStdoutAsContext` read as global bridge settings rather than facts about one point.

**Leave the payload helpers per bridge, as the comment asked.** Rejected: `lastTurn` and `blocksToText` are identical, and leaving the base fields behind would have left `base` itself a clone once the surrounding functions moved.

**Publish the new modules as subpath exports.** Rejected: no consumer needs one half without the other, and `index.ts` is already this package's published boundary, so `no-barrels` permits the forwards.

## The invariant companions' pre-commit staging, escalated and since resolved

This change left three clones between the `compaction`, `hook-protocol`, and `user-approval` invariant companions and escalated them rather than reshaping either side. Their shared text was the `traces`/`staged` `WeakMap` pair, the seed-existing-sessions loop, the `session/created` and `session/event` listeners, the `internal/dispatch` pre-commit stage, and the registration tail. The escalation named the constraint correctly: five packages carried that plumbing, so its owner had to be a package all five already depend on — `dsh-session`, which declares `Session`, `SessionEvent`, and both events, since the [invariant contracts note](../architecture/2026-07-19-package-invariant-runtime-contracts.md) forbids `dsh-invariants` from importing a product package.

It has since been done that way; see [the staging owner note](2026-09-03-session-staging-plumbing-owner.md). Two claims made here were wrong and are corrected rather than left standing. Roughly half of each clone's tokens was said to be the registration tail that `verify-package-invariants` mandates verbatim, so that half "cannot move without changing the gate" — measured, the tail alone is 46 tokens over 11 lines, under the 60-token floor, and never tripped the gate. And the plumbing had seven carriers, not five: `tool-todo` and `core/tools` held it too.

## Consequences

`bun run duplication` reports none of the six hook clones; the repository total fell from 20 to 8 while other packages' clones were being fixed in parallel. `packages/hooks/hook-protocol` gained four peer dependencies and four project references; its README still describes the package as a wire protocol and needs the same update. `hooks-claude-code` and `hooks-codex` no longer import `dsh-llm`, `dsh-session`, or `dsh-session-persistence` from their sources, though both still declare them. `dsh-hook-protocol`'s new modules are covered by the two bridges' suites rather than its own, which the repository-wide coverage run unions but a per-package lane would not.
