/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, and subagent
 * start/stop. It owns Claude payloads, environment, substitution, and the
 * decisions it honors; shared config loading, execution, parsing, and the five
 * extension points both dialects share live in `dsh-hook-protocol`.
 * `updatedInput` is logged and warned but not honored. Bespoke behavior should
 * use typed native plugins on the same extension points; see the
 * [hook-bridges Agent Note](../../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md).
 * @module @deepseek-ai/dsh-hooks-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  hookEventFields,
  injectHookContext,
  registerPostToolHook,
  registerPreStepHook,
  registerPreToolHook,
  registerSessionStartHook,
  registerTurnStoppingHook,
  startHookBridge,
} from '@deepseek-ai/dsh-hook-protocol'
import type { HookEventFields } from '@deepseek-ai/dsh-hook-protocol'
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { parseClaudeCodeConfig } from './config.ts'

export const name = 'hooks-claude-code'
// `bash` is required to run hooks; the rest are read opportunistically via
// ctx.get so a deployment can load this bridge without every extension point present.
export const inject = ['shell']

/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process. The bridge mounts at
   * process scope; each session shares this one path.
   */
  configPath: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's session workspace (`session.header.cwd`, the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
})

export function apply(ctx: Context, config: Config): void {
  // The config file is read once at load; a read or parse failure logs and
  // registers nothing.
  const bridge = startHookBridge(ctx, {
    dialect: 'claude-code',
    plugin: name,
    configPath: config.configPath,
    trailingNewline: true,
    unhonored: ['updatedInput', 'systemMessage'],
    ...config.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: config.defaultTimeoutMs } : {},
    ...config.stderrSummaryMaxChars !== undefined ? { stderrSummaryMaxChars: config.stderrSummaryMaxChars } : {},
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise it defaults to the
    // session workspace (the same dir the hook runs in).
    env: (workdir) => {
      const projectDir = config.projectDir ?? workdir
      return projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    },
    parse: (raw) => {
      const result = parseClaudeCodeConfig(raw, {
        ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
        ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
      })
      return {
        config: result.config,
        warnings: result.skipped.map(s => `skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`),
      }
    },
  })
  if (bridge === undefined) return

  // Claude Code ignores matchers on UserPromptSubmit and Stop, and its
  // permission decisions include `ask`, which routes to approval.
  registerSessionStartHook(ctx, bridge, {
    payload: (agent, source) => sessionStartPayload(ctx, agent, source),
    plainStdoutAsContext: false,
  })
  registerPreStepHook(ctx, bridge, {
    payload: ({ agent, prompt }) => promptPayload(ctx, agent, prompt),
    plainStdoutAsContext: false,
  })
  registerPreToolHook(ctx, bridge, { payload: exec => preToolPayload(ctx, exec), honorAsk: true })
  registerPostToolHook(ctx, bridge, { payload: (exec, response) => postToolPayload(ctx, exec, response) })
  registerTurnStoppingHook(ctx, bridge, { payload: agent => stopPayload(ctx, agent) })

  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the live child's workspace and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    bridge.detach(bridge.run('SubagentStart', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: bridge.detachedSignal })
      .then((merged) => { injectHookContext(bridge, child, merged) })
      .catch((error: unknown) => { bridge.warnFailure('SubagentStart', error) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    bridge.detach(bridge.run('SubagentStop', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStop', info, child), { ...child ? { agent: child } : {}, signal: bridge.detachedSignal }))
  })
}

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 */
const SUBAGENT_TYPE = 'general-purpose'

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. Claude Code writes `''`
// for a transcript it cannot locate. ---

function base(ctx: Context, agent: Agent | undefined, event: string): HookEventFields {
  return hookEventFields(ctx, agent, event, '')
}

function sessionStartPayload(ctx: Context, agent: Agent, source: string): Record<string, unknown> {
  return { ...base(ctx, agent, 'SessionStart'), source }
}
function promptPayload(ctx: Context, agent: Agent, prompt: string): Record<string, unknown> {
  return { ...base(ctx, agent, 'UserPromptSubmit'), prompt }
}
function preToolPayload(ctx: Context, exec: ToolExecution): Record<string, unknown> {
  return { ...base(ctx, exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(ctx: Context, exec: ToolExecution, response: string): Record<string, unknown> {
  return { ...base(ctx, exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: response }
}
function stopPayload(ctx: Context, agent: Agent): Record<string, unknown> {
  return { ...base(ctx, agent, 'Stop'), stop_hook_active: false }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false).
 */
function subagentPayload(ctx: Context, event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(ctx, child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}
