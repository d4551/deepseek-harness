/**
 * The facts the one-shot shell tool states differently per shell: its
 * model-facing name, its command vocabulary, the prompt section it contributes,
 * and the job kind background runs register under. Everything the two shells
 * state identically stays in `index.ts`.
 * @module @deepseek-ai/dsh-tool-shell/src/dialect
 */

import { FIRST_PARTY_SECTION_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { DSH_ENV_PREFIX } from '@deepseek-ai/dsh-shell'
import type { JobKind } from '@deepseek-ai/dsh-jobs'

/** The shells this tool can speak; a composition selects exactly one per mount. */
export type ShellDialectName = 'bash' | 'pwsh'

/** One shell's model-facing vocabulary. Every field reaches a model request verbatim. */
export interface ShellToolDialect {
  /** Registered tool name, which is also the approval subject tool. */
  toolName: ShellDialectName
  /** Job kind a `run_in_background` call registers with `ctx.jobs`. */
  jobKind: JobKind
  /** System-prompt section name; scoped restrictions address it by this name. */
  sectionName: string
  /** First-party prompt-section order for this shell. */
  sectionOrder: number
  /** The prompt section's complete text. */
  sectionText: string
  /** Opening sentence of the tool description, naming the shell and its argv form. */
  intro: string
  /** How much state survives a call, plus any path and variable spelling the shell needs. */
  freshProcess: string
  /** How the managed harness environment is read in this shell. */
  managedEnv: string
  /** Shell-specific termination or platform behavior; empty when the shell adds none. */
  platformNote: string
  /** Confinement text preceding the shared escalation guidance; empty when the shell adds none. */
  escalationPrefix: string
  /** Description of the `command` parameter. */
  commandDescription: string
  /** The third `description`-parameter example, in this shell's command vocabulary. */
  descriptionExample: string
}

/**
 * Every dialect this tool speaks, keyed by its `dialect` config value. The
 * `Record` key type makes a new member a compile error until it is stated here.
 */
export const SHELL_TOOL_DIALECTS: Record<ShellDialectName, ShellToolDialect> = {
  bash: {
    toolName: 'bash',
    jobKind: 'bash',
    sectionName: 'tool:bash',
    sectionOrder: FIRST_PARTY_SECTION_ORDER.TOOL_BASH,
    sectionText: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.',
    intro: 'Execute a bash command (`bash -c`) and return its stdout/stderr. ',
    freshProcess: 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
      + 'pass `workdir` instead of using `cd`. ',
    managedEnv: `Current harness environment facts are exposed through managed \`$${DSH_ENV_PREFIX}*\` variables; inspect them when needed. `,
    platformNote: '',
    escalationPrefix: '',
    commandDescription: 'The bash command to execute.',
    descriptionExample: '"npm install" → "Install package dependencies"',
  },
  pwsh: {
    toolName: 'pwsh',
    jobKind: 'pwsh',
    sectionName: 'tool:pwsh',
    sectionOrder: FIRST_PARTY_SECTION_ORDER.TOOL_PWSH,
    sectionText: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. '
      + 'On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.',
    intro: 'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr. ',
    freshProcess: 'Each call runs in a fresh pwsh process: no state (cwd, variables, functions) persists between calls — '
      + 'pass `workdir` instead of using `cd`. Paths use native Windows form (`C:\\...`); read environment '
      + 'variables with `$env:NAME`. ',
    managedEnv: `Current harness environment facts are exposed through managed \`$env:${DSH_ENV_PREFIX}*\` variables; inspect them when needed. `,
    platformNote: 'On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. ',
    // The language-mode and named-pipe contracts below are Windows-restricted-token
    // behavior, but the gate is 'any confining executor is mounted' (escalationModes
    // non-empty). Every shipped composition pairing the pwsh dialect with a confining
    // executor is win32-only, so the gate is equivalent. A POSIX pwsh-sandbox
    // composition must gate both sentences on the platform instead (tracked in the
    // pwsh-tool-and-executor Agent Note).
    escalationPrefix: 'Under the Windows sandbox, read-only pwsh runs in PowerShell ConstrainedLanguage mode, while '
      + 'workspace-write stays in FullLanguage unless host policy says otherwise. In read-only, prefer cmdlets and core types (`[string]`, `[datetime]`, `[regex]`, `[guid]`); '
      + '.NET static calls (`[System.IO.*]::`, `[math]::`), `Add-Type`, COM objects, and reflection fail '
      + 'with "only core types" errors. `-f` formatting, property access, and core cmdlets work. '
      + 'In both confined modes, programs cannot open named pipes, so a command that captures another '
      + 'program\'s output through piped stdio (Node.js `child_process.spawn`/`exec` with the default '
      + '`stdio: \'pipe\'`) fails with EPERM, while `stdio: \'inherit\'` and `stdio: \'ignore\'` spawns '
      + 'work and PowerShell\'s own pipelines are unaffected. That EPERM is the documented boundary: '
      + 'do not retry the command another way — escalate the exact command once or restructure it to '
      + 'avoid capturing output. ',
    commandDescription: 'The PowerShell command to execute.',
    descriptionExample: '"Get-Process" → "List running processes"',
  },
}
