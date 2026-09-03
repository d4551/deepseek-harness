/**
 * Codex's contribution to the shared hook-config parse: the five events this
 * bridge supports, regex-only matchers, and the entry conversion for a
 * `{ type, command, timeout | timeoutSec, async }` hook. Only synchronous
 * command hooks run; other types and `async: true` commands are recorded as
 * skipped. Codex performs no command substitution. The group skeleton, matcher
 * validation, and the rule that UserPromptSubmit and Stop carry no matcher
 * subject live in `dsh-hook-protocol`.
 * @module @deepseek-ai/dsh-hooks-codex/config
 */

import { parseHookGroups } from '@deepseek-ai/dsh-hook-protocol'
import type { ParsedHookGroups } from '@deepseek-ai/dsh-hook-protocol'

/** The five Codex hook points this bridge supports. */
export const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop'] as const

/** A skipped non-command (or async) hook, surfaced so the bridge can warn. */
export interface SkippedHook {
  /** The event the skipped hook was configured under. */
  event: string
  /** Why it was skipped, worded for the bridge's warning. */
  reason: string
}

/**
 * Parse a wrapped or bare Codex event map. Unknown events and malformed entries
 * are ignored rather than failing boot; unsupported or asynchronous hooks are
 * returned in `skipped`. A matcher-bearing runnable group with an invalid regex
 * throws a `SyntaxError`, allowing the bridge to reject the complete config
 * before listener registration.
 * @param raw - the parsed JSON config: a `{ hooks: … }` wrapper or the bare event map.
 * @returns the runnable per-event groups plus the skipped hooks with their reasons.
 */
export function parseCodexConfig(raw: unknown): ParsedHookGroups<SkippedHook> {
  return parseHookGroups<SkippedHook>(raw, {
    events: CODEX_EVENTS,
    mode: 'codex',
    hook: (hook, event, skip) => {
      const type = typeof hook.type === 'string' ? hook.type : 'command'
      if (type !== 'command') {
        skip({ event, reason: `unsupported "${type}" hook` })
        return undefined
      }
      if (hook.async === true) {
        skip({ event, reason: 'async hook' })
        return undefined
      }
      if (typeof hook.command !== 'string') return undefined
      // Codex accepts `timeout` or the `timeoutSec` alias.
      const timeout = typeof hook.timeout === 'number' ? hook.timeout
        : typeof hook.timeoutSec === 'number' ? hook.timeoutSec : undefined
      return { command: hook.command, ...timeout !== undefined ? { timeoutSec: timeout } : {} }
    },
  })
}
