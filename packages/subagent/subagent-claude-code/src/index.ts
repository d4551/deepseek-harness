/**
 * Profile-named Claude Code one-shot subagent provider. Every accepted run
 * invokes the official Agent SDK in the delegating Session's workspace, hands
 * the child that Session's other workspace roots as the SDK's
 * `additionalDirectories`, and places the SDK-spawned real CLI under the
 * shared subprocess owner.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assertTimerBound,
  NO_START_CAPABILITIES,
  OneShotProviderConfigFields,
  resolveChildCwd,
  resolveChildWorkspaceRoots,
  resolveOneShotProviderConfig,
  type OneShotRunConfig,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  CLAUDE_CODE_PERMISSION_MODES,
  DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  claudeCodeStartupFailure,
  startClaudeCodeRun,
  type ClaudeCodePermissionMode,
  type ClaudeCodeRunSpec,
} from './run.ts'

export const name = 'subagent-claude-code'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'claude-code'

/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `claude-code`). */
  providerName?: string
  /** Native Claude model fixed for this instance; omitted to inherit Claude settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /**
   * Native non-interactive mode fixed for this Provider instance. Defaults to
   * `dontAsk`; `acceptEdits` accepts edits, `auto` uses the native classifier,
   * `plan` returns a plan without approving execution, and
   * `bypassPermissions` explicitly skips permission checks.
   */
  permissionMode?: ClaudeCodePermissionMode
  /** Grace in milliseconds for Claude Code process-tree termination. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.intersect([
  z.object(OneShotProviderConfigFields),
  z.object({
    providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
    permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES])
      .default(DEFAULT_CLAUDE_CODE_PERMISSION_MODE),
    disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  }),
])

class ClaudeCodeProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: OneShotRunConfig<ClaudeCodePermissionMode>,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-claude-code: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-claude-code',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-claude-code: request was aborted before SDK startup',
        )
      }
      const failure = claudeCodeStartupFailure(error)
      this.ctx.logger.warn(
        `subagent-claude-code "${this.name}": child start failed: %o`,
        failure,
      )
      throw failure
    }
    const spec: ClaudeCodeRunSpec = {
      ...this.config,
      cwd,
      workspaceRoots: resolveChildWorkspaceRoots(request.parent, cwd),
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-claude-code "${this.name}": child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startClaudeCodeRun(request, spec)
  }
}

/**
 * Register one Profile-named Claude Code provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const { providerName, run } = resolveOneShotProviderConfig(config, {
    providerName: DEFAULT_PROVIDER_NAME,
    permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
  })
  assertTimerBound('subagent-claude-code', 'disposeGraceMs', run.disposeGraceMs)
  ctx.subagents.registerProvider(new ClaudeCodeProvider(providerName, ctx, run))
}
