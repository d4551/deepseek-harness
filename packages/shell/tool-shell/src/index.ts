/**
 * Model-facing Consumer of the `ctx.shell` capability seam, speaking the shell
 * dialect the composition selects. Background calls register process handles
 * with `ctx.jobs`; their work uses job cancellation rather than the tool-call
 * signal after an id is returned.
 *
 * TODO(permissions): deployment policy belongs in `tools/pre-execute` and
 * sandboxing executors; see docs/architecture.md § Where new behavior goes.
 * @module @deepseek-ai/dsh-tool-shell
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, TerminalCallView, ToolExecution, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-shell-env'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import {
  SHELL_BACKGROUND_PARAMETER,
  SHELL_ESCALATION_GUIDANCE,
  SHELL_JUSTIFICATION_PARAMETER,
  SHELL_TIMEOUT_PARAMETER,
  SHELL_TOOL_OUTPUT_SCHEMA,
  SHELL_WORKDIR_PARAMETER,
  canonicalShellResult,
  parseExitStatus,
  processOutcome,
  renderShellProcessRead,
  renderShellResult,
  shellEscalationParameter,
  validateShellToolArgs,
} from '@deepseek-ai/dsh-shell'
import type { RenderableShellResult, ShellToolArgs } from '@deepseek-ai/dsh-shell'
import { SHELL_TOOL_DIALECTS } from './dialect.ts'
import type { ShellDialectName, ShellToolDialect } from './dialect.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    pwsh: 'pwsh'
  }
}

export const name = 'tool-shell'
export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']

/** Configuration for the one-shot shell tool. */
export interface Config {
  /** Shell whose name, command vocabulary, and prompt section this mount publishes. */
  dialect: ShellDialectName
  /** Expose `run_in_background` (default true); disabled calls are also rejected. */
  enableRunInBackground?: boolean
}

/** Runtime configuration schema for the one-shot shell tool plugin. */
export const Config: z<Config> = z.object({
  dialect: z.union([z.const('bash'), z.const('pwsh')]).required(),
  enableRunInBackground: z.boolean().default(true),
})

/**
 * Assemble the complete model-facing tool description for one mount.
 * @param dialect - the selected shell's vocabulary.
 * @param backgroundEnabled - whether `run_in_background` is advertised.
 * @param escalationModes - modes a denied command may escalate to; empty without a confining executor.
 * @returns the description string the tool registers.
 */
function shellDescription(
  dialect: ShellToolDialect,
  backgroundEnabled: boolean,
  escalationModes: readonly SandboxMode[],
): string {
  const background = backgroundEnabled
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  const base = dialect.intro
    + dialect.freshProcess
    + 'Non-zero exits are reported as `[exit code: N]`. '
    + dialect.managedEnv
    + 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + dialect.platformNote
    + background
  if (escalationModes.length === 0) return base
  return `${base} ${dialect.escalationPrefix}${SHELL_ESCALATION_GUIDANCE}`
}

/**
 * Present foreground calls as terminals and background starts as generic cards.
 * The command remains the title on both paths; foreground cwd is passed through
 * for the bridge to resolve, while background descriptions remain card content.
 */
type ShellCallArgs = { command: string; description: string; workdir?: string; run_in_background?: boolean }

function presentShellCall(args: ShellCallArgs): GenericCallView | TerminalCallView {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: args.command,
      kind: 'execute',
      rawInput: args.command,
      content: [{ type: 'text', text: args.description }],
    }
  }
  return {
    card: 'terminal',
    title: args.command,
    description: args.description,
    ...args.workdir !== undefined ? { cwd: args.workdir } : {},
  }
}

/**
 * Present completed foreground output as a terminal; background acknowledgements
 * and execution errors use generic fenced output without an exit-status pill.
 */
function presentShellResult(args: unknown, result: ToolResult): ToolResultView | undefined {
  const block = result.content.length === 1 ? result.content[0] : undefined
  if (block === undefined || block.type !== 'text') return undefined
  const raw = block.text
  const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
  // Background acknowledgements and errors have no terminal exit status.
  if (isBackground || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
  }
  // The exit marker becomes the card's exit pill, so it leaves the output body.
  const { body, ...exit } = parseExitStatus(raw)
  return { card: 'terminal', output: body, ...exit }
}

/**
 * Resolve an explicit workdir first, making a relative one session-workspace-relative;
 * otherwise use the filesystem identity of the session cwd and leave executor
 * defaulting as the fallback. A resolved sandbox-policy root wins so workdir
 * and confinement use the exact same per-call identity.
 */
function resolveWorkdir(
  modelWorkdir: string | undefined,
  exec: { agent?: Agent },
  policyWorkspaceRoot?: string,
): string | undefined {
  const headerCwd = exec.agent?.session.header.cwd
  const sessionCwd = policyWorkspaceRoot ?? (headerCwd === undefined ? undefined : canonicalPath(headerCwd))
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) {
    return resolvePath(sessionCwd, modelWorkdir)
  }
  return modelWorkdir
}

export function apply(ctx: Context, config: Config): void {
  const dialect = SHELL_TOOL_DIALECTS[config.dialect]
  const backgroundEnabled = config.enableRunInBackground ?? true
  const defaultMode = ctx.shell.sandboxMode
  const escalationModes: readonly SandboxMode[] = defaultMode === undefined ? [] : ESCALATION_TARGETS
  const sandboxPolicy: SandboxPolicyService | undefined = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error(`tool-shell: the mounted ${dialect.toolName} executor confines but ctx.sandboxPolicy is missing`)
  }
  /** Resolve the complete standing policy for this call when a confining executor is mounted. */
  const resolveSandboxPolicy = (exec: ToolExecution): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  /**
   * Resolve a sandbox-escalation request through `ctx.approval` BEFORE
   * anything executes, delegating the shared fail-closed sequence (strict
   * widening, channel resolution, outcome mapping) to
   * {@link approveEscalation}. This tool contributes only the composition
   * guard (the fields are unadvertised without a sandboxing executor, yet
   * schema validation checks advertised keys only, so an unadvertised
   * `sandbox_permissions` still reaches execute) and the approval
   * ingredients. The shared policy resolver is required whenever the executor
   * advertises confinement, so a split composition fails at tool-plugin load.
   */
  const approveShellEscalation = (
    mode: string,
    justification: string,
    exec: ToolExecution,
    standingPolicy: SandboxExecutionPolicy | undefined,
  ): Promise<SandboxMode> => {
    if (escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
    }
    const effectiveMode = (standingPolicy as SandboxExecutionPolicy).mode
    return approveEscalation(
      { requestedMode: mode, justification, effectiveMode, subject: 'command' },
      {
        approver: ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName: dialect.toolName,
        signal: exec.signal,
      },
    )
  }

  // Cross-call guidance belongs in the prompt rather than one-call schema prose.
  ctx.systemPrompt.section({
    name: dialect.sectionName,
    order: dialect.sectionOrder,
    text: dialect.sectionText,
  })

  ctx.tools.register(defineTool({
    name: dialect.toolName,
    description: shellDescription(dialect, backgroundEnabled, escalationModes),
    parameters: {
      command: { type: 'string', required: true, description: dialect.commandDescription },
      description: {
        type: 'string',
        required: true,
        description: 'Clear, concise description of what this command does in active voice, '
          + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
          + `"git status" → "Show working tree status"; ${dialect.descriptionExample}.`,
      },
      timeoutMs: SHELL_TIMEOUT_PARAMETER,
      workdir: SHELL_WORKDIR_PARAMETER,
      ...backgroundEnabled ? { run_in_background: SHELL_BACKGROUND_PARAMETER } : {},
      ...escalationModes.length > 0 ? {
        sandbox_permissions: shellEscalationParameter(escalationModes),
        justification: SHELL_JUSTIFICATION_PARAMETER,
      } : {},
    },
    output: {
      schema: SHELL_TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background job ${value.jobId}`
          : renderShellResult(value as RenderableShellResult, escalationModes),
      }],
    },
    async execute(args: ShellToolArgs, exec) {
      validateShellToolArgs(args)
      // Description is display metadata; workdir defaults to the caller's session.
      const standingPolicy = resolveSandboxPolicy(exec)
      const approvedMode = args.sandbox_permissions !== undefined && args.justification !== undefined
        ? await approveShellEscalation(args.sandbox_permissions, args.justification, exec, standingPolicy)
        : undefined
      const policy = approvedMode === undefined
        ? standingPolicy
        : { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
      const workdir = resolveWorkdir(args.workdir, exec, standingPolicy?.workspaceRoot)
      const request = {
        command: args.command,
        ...workdir !== undefined ? { workdir } : {},
        ...args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {},
        dshEnv: ctx.shellEnv.collect(exec),
        ...policy !== undefined ? { sandboxPolicy: policy } : {},
      }
      if (args.run_in_background === true) {
        // Undeclared keys are allowed, so schema omission also needs enforcement.
        if (!backgroundEnabled) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        // The caller owns cancellation until ctx.jobs commits detached ownership.
        if (exec.signal.aborted) {
          const error = new HarnessError('tool call aborted', TOOL_ABORTED)
          error.name = 'AbortError'
          throw error
        }
        // Task preflight finishes before the starter can spawn a process.
        const id = jobs.start({
          kind: dialect.jobKind,
          label: args.command,
          ...exec.agent ? { owner: exec.agent } : {},
          run: () => {
            const proc = ctx.shell.start(ctx.shell.resolve(request))
            return {
              cancel: () => void proc.kill(),
              done: proc.done.then(() => processOutcome(proc)),
              readOutput: () => renderShellProcessRead(proc.readOutput(), proc.sandbox, escalationModes),
            }
          },
        })
        return { kind: 'background' as const, jobId: id }
      }
      const result = await ctx.shell.run(ctx.shell.resolve({
        ...request,
        signal: exec.signal,
      }))
      if (result.aborted) {
        const error = new HarnessError('tool call aborted', TOOL_ABORTED)
        error.name = 'AbortError'
        throw error
      }
      return { kind: 'foreground' as const, ...canonicalShellResult(result) }
    },
    presentCall: presentShellCall,
    presentResult: presentShellResult,
  }))
}
