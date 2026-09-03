/**
 * Local Service Provider for the bash capability seam over the subprocess
 * capability seam. Public commands run as `bash -c` in a managed process group
 * spawned through `ctx.subprocess`. This package owns the bash dialect — the
 * argv, the POSIX terminal environment, and the diagnostic label; deadlines,
 * cause classification, output budgets, and the background read merge are
 * `SubprocessShellExecutor`'s. Execution policy belongs in `tools/pre-execute`
 * or a sandboxing executor.
 * @module @deepseek-ai/dsh-bash-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { subprocessShellConfigFields } from '@deepseek-ai/dsh-shell'
import type { ShellExecSpec, SubprocessShellConfig } from '@deepseek-ai/dsh-shell'
import { SubprocessShellExecutor } from '@deepseek-ai/dsh-shell/subprocess-executor'
import type { ShellDialect } from '@deepseek-ai/dsh-shell/subprocess-executor'

/**
 * Model-friendly environment overrides: disable colors, pagers, and
 * interactive terminal features that would garble tool output (the same set
 * Codex hardcodes; Claude Code achieves it via TERM=dumb). `TERM` is a POSIX
 * concept, so the pwsh dialect omits it.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/** The bash dialect: how this provider names itself and what environment its shell understands. */
const BASH_DIALECT: ShellDialect = { label: 'bash-local', envOverrides: ENV_OVERRIDES }

/** Plugin config (all optional — `static Config` supplies the defaults). */
export type Config = SubprocessShellConfig

/** The config fields this provider shares with every subprocess-backed shell executor. */
const SHARED_FIELDS = subprocessShellConfigFields()

/**
 * Local bash executor over `ctx.subprocess`: it contributes the `bash -c` argv
 * and inherits every process mechanic from {@link SubprocessShellExecutor}.
 */
export class LocalBashExecutor extends SubprocessShellExecutor {
  static inject = ['subprocess']

  // Each accepted key is named here because the config catalog walks this
  // literal statically; every schema behind a name comes from the seam.
  static Config: z<Config> = z.object({
    cwd: SHARED_FIELDS.cwd, timeoutMs: SHARED_FIELDS.timeoutMs, maxTimeoutMs: SHARED_FIELDS.maxTimeoutMs,
    maxOutputBytes: SHARED_FIELDS.maxOutputBytes, maxSpillBytes: SHARED_FIELDS.maxSpillBytes, graceMs: SHARED_FIELDS.graceMs,
  })

  constructor(ctx: Context, config: Config) {
    super(ctx, config, BASH_DIALECT)
    this.installShellSettings(LocalBashExecutor.Config, config)
  }

  /**
   * The bash invocation argv for one resolved spec: the command is one argv
   * element, so `bash` itself parses it and no intermediate shell quoting
   * layer exists. A confining subclass wraps exactly this argv.
   */
  protected argv(spec: ShellExecSpec): readonly string[] {
    return ['bash', '-c', spec.command]
  }
}

export default LocalBashExecutor
