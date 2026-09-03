/**
 * Claude Code's contribution to the shared hook-config parse: the events this
 * bridge supports, the literal-or-regex matcher mode, and the entry conversion
 * for a `{ type, command, timeout }` hook. Only command hooks run; other hook
 * types are recorded as skipped so the bridge can warn. Plugin-root and
 * project-directory substitutions are applied to commands at parse time. The
 * group skeleton, matcher validation, and the rule that UserPromptSubmit and
 * Stop carry no matcher subject live in `dsh-hook-protocol`.
 * @module @deepseek-ai/dsh-hooks-claude-code/config
 */

import { parseHookGroups } from '@deepseek-ai/dsh-hook-protocol'
import type { ParsedHookGroups } from '@deepseek-ai/dsh-hook-protocol'

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const

/** A skipped non-command hook, surfaced so the bridge can warn about it. */
export interface SkippedHook {
  /** The event the skipped hook was configured under. */
  event: string
  /** The unsupported `type` value that skipped it. */
  type: string
}

/** Substitution variables applied to each `command` string at parse time. */
export interface SubstitutionVars {
  /** Replaces `${CLAUDE_PLUGIN_ROOT}` — the plugin's root dir. */
  pluginRoot?: string
  /** Replaces `${CLAUDE_PROJECT_DIR}` — the project root. */
  projectDir?: string
}

/**
 * Apply `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PROJECT_DIR}` substitution to a command string.
 * @param command - the raw command from config.
 * @param vars - the substitution values; a token whose variable is unset stays verbatim.
 * @returns the command with every occurrence of each set token replaced.
 */
export function substituteCommand(command: string, vars: SubstitutionVars): string {
  let out = command
  if (vars.pluginRoot !== undefined) out = out.split('${CLAUDE_PLUGIN_ROOT}').join(vars.pluginRoot)
  if (vars.projectDir !== undefined) out = out.split('${CLAUDE_PROJECT_DIR}').join(vars.projectDir)
  return out
}

/**
 * Parse either a settings `hooks` value or a bare `hooks.json` event map.
 * Malformed entries are ignored rather than failing boot; unsupported events
 * are ignored before their groups are parsed, non-command hooks are returned in
 * `skipped`, and substitutions are applied to every surviving command. A
 * matcher-bearing supported runnable group with an invalid regex throws a
 * `SyntaxError`, allowing the bridge to reject the complete config before
 * listener registration.
 * @param raw - the parsed JSON config: a settings object with a `hooks` key, or the bare event map.
 * @param vars - substitution values applied to every surviving `command` (defaults to none).
 * @returns the runnable per-event groups plus the skipped non-command hooks.
 */
export function parseClaudeCodeConfig(raw: unknown, vars: SubstitutionVars = {}): ParsedHookGroups<SkippedHook> {
  return parseHookGroups<SkippedHook>(raw, {
    events: CLAUDE_EVENTS,
    mode: 'claude-code',
    hook: (hook, event, skip) => {
      const type = typeof hook.type === 'string' ? hook.type : 'command'
      if (type !== 'command') {
        skip({ event, type })
        return undefined
      }
      if (typeof hook.command !== 'string') return undefined
      return {
        command: substituteCommand(hook.command, vars),
        ...typeof hook.timeout === 'number' ? { timeoutSec: hook.timeout } : {},
      }
    },
  })
}
