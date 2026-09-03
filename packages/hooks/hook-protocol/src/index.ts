/**
 * Shared, non-plugin hook bridge library: config loading and matcher-group
 * parsing, matching, command execution and decoding, restrictive outcome
 * merging, durable event helpers, detached run quiescence, and the interception
 * extension points both dialects map onto. Claude Code and Codex bridges own
 * their distinct payload field sets, config entry formats, environment rules,
 * and the capabilities each honors.
 * @module @deepseek-ai/dsh-hook-protocol
 */

export type {
  CommandHook,
  HookDialect,
  HookOutput,
  MatcherGroup,
  MatcherMode,
} from './types.ts'
export { matcherDiagnostic, matchesMatcher } from './matcher.ts'
export { parseHookOutput } from './codec.ts'
export { DEFAULT_HOOK_TIMEOUT_MS, runHook } from './runner.ts'
export type { RunHookOptions, RunHookResult } from './runner.ts'
export { mergeHookOutputs } from './merge.ts'
export type { MergedDecision, MergedHookOutcome } from './merge.ts'
export { appendHookInvoked, appendHookResult, DEFAULT_STDERR_SUMMARY_MAX_CHARS, summarizeStderr } from './events.ts'
export type { HookInvocation, HookResultRecord } from './events.ts'
export { createDetachedRuns } from './detached.ts'
export type { DetachedRuns } from './detached.ts'
export { parseHookGroups } from './config.ts'
export type { HookGroupParseRules, HookGroups, ParsedHookGroups } from './config.ts'
export { hookEventFields, lastTurn } from './payload.ts'
export type { HookEventFields } from './payload.ts'
export { startHookBridge } from './bridge.ts'
export type { HookBridge, HookBridgeOptions, HookRunScope, UnhonoredHookField } from './bridge.ts'
export {
  injectHookContext,
  registerPostToolHook,
  registerPreStepHook,
  registerPreToolHook,
  registerSessionStartHook,
  registerTurnStoppingHook,
} from './extension-points.ts'
export type {
  PostToolHookOptions,
  PreStepHookOptions,
  PreToolHookOptions,
  SessionStartHookOptions,
  TurnStoppingHookOptions,
} from './extension-points.ts'
