/**
 * Bridge for unmodified Codex command hooks on harness interception points. It
 * supports five points (SessionStart, prompt/tool pre/post, Stop), regex-only
 * matchers, snake_case payloads without a trailing newline, no hook environment
 * or command substitution, and no pre-tool approval or rewrite path; only
 * blocking decisions are honored. Shared config loading, execution, parsing,
 * and the five extension points both dialects share live in
 * `dsh-hook-protocol`; see the
 * [hook-bridges Agent Note](../../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md).
 * @module @deepseek-ai/dsh-hooks-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  hookEventFields,
  lastTurn,
  registerPostToolHook,
  registerPreStepHook,
  registerPreToolHook,
  registerSessionStartHook,
  registerTurnStoppingHook,
  startHookBridge,
} from '@deepseek-ai/dsh-hook-protocol'
import { parseCodexConfig } from './config.ts'

export const name = 'hooks-codex'
export const inject = ['shell']

/** Plugin config: where the Codex hooks.json lives + the model name for payloads. */
export interface Config {
  /**
   * Path to a Codex `hooks.json`. Process-level: read once at load, a relative
   * path resolves against the process launch cwd. The bridge mounts at process
   * scope; each session shares this one path.
   */
  configPath: string
  /** The model name stamped on every payload (Codex includes `model` on each event). */
  model?: string
  /** Default per-hook timeout in ms when a hook sets none (Codex default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  model: z.string().default(''),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
})

export function apply(ctx: Context, config: Config): void {
  const model = config.model ?? ''
  // Codex writes stdin without a trailing newline and exports no hook environment.
  const bridge = startHookBridge(ctx, {
    dialect: 'codex',
    plugin: name,
    configPath: config.configPath,
    trailingNewline: false,
    unhonored: ['systemMessage'],
    ...config.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: config.defaultTimeoutMs } : {},
    ...config.stderrSummaryMaxChars !== undefined ? { stderrSummaryMaxChars: config.stderrSummaryMaxChars } : {},
    parse: (raw) => {
      const result = parseCodexConfig(raw)
      return {
        config: result.config,
        warnings: result.skipped.map(s => `skipping ${s.reason} on ${s.event} (only sync command hooks run)`),
      }
    },
  })
  if (bridge === undefined) return

  // Codex reads clean plain stdout as context on its two context-bearing
  // points, honors blocking decisions only (no allow/ask), and has one
  // emit-shaped point: SessionStart.
  registerSessionStartHook(ctx, bridge, {
    payload: (agent, source) => ({ ...base(ctx, agent, 'SessionStart', model), source }),
    plainStdoutAsContext: true,
  })
  registerPreStepHook(ctx, bridge, {
    payload: ({ agent, turn, prompt }) => ({ ...base(ctx, agent, 'UserPromptSubmit', model), turn_id: String(turn), prompt }),
    plainStdoutAsContext: true,
  })
  registerPreToolHook(ctx, bridge, { payload: exec => preToolPayload(ctx, exec, model), honorAsk: false })
  registerPostToolHook(ctx, bridge, { payload: (exec, response) => postToolPayload(ctx, exec, response, model) })
  registerTurnStoppingHook(ctx, bridge, {
    // TODO(stop-loop-guard): Codex supplies `stop_hook_active` so a Stop hook can
    // avoid continuing the same turn indefinitely. It is always false here, so an
    // unconditionally blocking hook force-continues every step until it self-limits.
    payload: agent => ({ ...turnBase(ctx, agent, 'Stop', model), stop_hook_active: false, last_assistant_message: null }),
  })
}

// --- Codex DIALECT payloads: snake_case, model on every event, turn_id on
// turn-scoped events, and `null` for a transcript it cannot locate. ---

/** Base fields on every Codex payload (no turn_id). */
function base(ctx: Context, agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return { ...hookEventFields(ctx, agent, event, null), model, permission_mode: 'default' }
}

/** Base + turn_id, for the turn-scoped events (PreToolUse/PostToolUse/Stop). */
function turnBase(ctx: Context, agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return { ...base(ctx, agent, event, model), turn_id: String(lastTurn(agent)) }
}

/** Extract a `command` string from a tool call's parsed arguments, else ''. */
function commandOf(args: unknown): string {
  if (typeof args === 'object' && args !== null && 'command' in args) {
    const command: unknown = args.command
    if (typeof command === 'string') return command
  }
  return ''
}

function preToolPayload(ctx: Context, exec: ToolExecution, model: string): Record<string, unknown> {
  // `tool_name` is the REAL tool name (matching the `exec.name` matcher subject);
  // a hardcoded constant would disagree with what the matcher tests and make a
  // config's tool matcher never fire. `tool_input` keeps Codex's `{ command }`
  // shape (its shell payload), derived from the call's `command` arg when present.
  return { ...turnBase(ctx, exec.agent, 'PreToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId }
}

function postToolPayload(ctx: Context, exec: ToolExecution, response: string, model: string): Record<string, unknown> {
  return { ...turnBase(ctx, exec.agent, 'PostToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId, tool_response: response }
}
