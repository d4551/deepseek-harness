/**
 * Local PowerShell Service Provider for the bash capability seam. Each command runs
 * as `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` in a managed
 * process spawned through `ctx.subprocess`. This package owns the PowerShell
 * dialect — executable resolution, the invocation argv, the UTF-8 output
 * pinning, and the environment pwsh honors; deadlines, cause classification,
 * output budgets, and the background read merge are
 * `SubprocessShellExecutor`'s.
 *
 * The command string is passed as ONE argv element to `-Command`: PowerShell
 * itself parses the text, and no intermediate shell exists, so there is no
 * shell-quoting layer to escape (the `bash -c` string domain has no
 * equivalent here). Native Win32 paths (`C:\...`) pass through unchanged.
 *
 * @module @deepseek-ai/dsh-pwsh-local
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { subprocessShellConfigFields } from '@deepseek-ai/dsh-shell'
import type { ShellExecSpec, SubprocessShellConfig } from '@deepseek-ai/dsh-shell'
import { SubprocessShellExecutor } from '@deepseek-ai/dsh-shell/subprocess-executor'
import type { ShellDialect } from '@deepseek-ai/dsh-shell/subprocess-executor'
import { resolvePwshPath } from './resolve.ts'

/**
 * Model-friendly environment overrides for PowerShell: disable colors and
 * pagers that would garble tool output. `TERM=dumb` is a POSIX concept and is
 * deliberately absent; `NO_COLOR` is honored by modern pwsh renderers.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/**
 * UTF-8 output pinning prepended to every command. The subprocess collector
 * decodes output bytes as UTF-8, but Windows PowerShell 5.1 (the last-resort
 * executable fallback) writes the console/OEM code page by default, which
 * garbles non-ASCII output; pwsh 7 defaults to UTF-8 and is unaffected. The
 * statements ride on line 1 after `; ` separators so PowerShell error line
 * numbers stay accurate.
 */
export const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** The pwsh dialect: how this provider names itself and what environment PowerShell honors. */
const PWSH_DIALECT: ShellDialect = { label: 'pwsh-local', envOverrides: ENV_OVERRIDES }

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config extends SubprocessShellConfig {
  /**
   * Explicit pwsh executable. When omitted, well-known Windows install
   * locations and PATH entries are probed in order (PowerShell 7 install,
   * PATH entries such as the Microsoft Store install, then Windows
   * PowerShell 5.1), falling back to a bare `pwsh` resolved through PATH.
   */
  pwshPath?: string
}

// Resolution lives in its own dependency-free module so the repository's
// coverage-gate probe shares the exact definition the suites use.
export { candidatePwshPaths, resolvePwshPath } from './resolve.ts'

/** The config fields this provider shares with every subprocess-backed shell executor. */
const SHARED_FIELDS = subprocessShellConfigFields()

/**
 * Local PowerShell executor over `ctx.subprocess`: it contributes the pwsh
 * invocation argv and inherits every process mechanic from
 * {@link SubprocessShellExecutor}.
 */
export class PwshLocalExecutor extends SubprocessShellExecutor<Config> {
  static inject = ['subprocess']

  // Each accepted key is named here because the config catalog walks this
  // literal statically; every shared schema behind a name comes from the seam,
  // and `pwshPath` is this provider's own.
  static Config: z<Config> = z.object({
    cwd: SHARED_FIELDS.cwd, timeoutMs: SHARED_FIELDS.timeoutMs, maxTimeoutMs: SHARED_FIELDS.maxTimeoutMs,
    maxOutputBytes: SHARED_FIELDS.maxOutputBytes, maxSpillBytes: SHARED_FIELDS.maxSpillBytes, graceMs: SHARED_FIELDS.graceMs,
    pwshPath: z.string(),
  })

  /** The declared executable the current {@link pwshPath} was resolved from. */
  private declaredPwshPath: string | undefined

  /** The pwsh executable resolved from the current config. */
  private resolvedPwshPath: string

  /** The pwsh executable every command runs through. */
  get pwshPath(): string {
    return this.resolvedPwshPath
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, config, PWSH_DIALECT)
    this.declaredPwshPath = config.pwshPath
    this.resolvedPwshPath = resolvePwshPath(config.pwshPath)
    this.installShellSettings(PwshLocalExecutor.Config, config)
  }

  /**
   * Probing the filesystem is the one fact this provider derives from the
   * config: every other field is read through `config` at each command.
   */
  protected override onConfigChange(): void {
    const declared = this.config.pwshPath
    if (declared === this.declaredPwshPath) return
    this.declaredPwshPath = declared
    this.resolvedPwshPath = resolvePwshPath(declared)
  }

  /**
   * The pwsh invocation argv for one resolved spec — the argv-level seam a
   * confining subclass wraps through `ctx.sandbox.confine` (see
   * `@deepseek-ai/dsh-pwsh-sandbox`).
   */
  protected argv(spec: ShellExecSpec): readonly string[] {
    return [this.pwshPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${spec.command}`]
  }
}

export default PwshLocalExecutor
