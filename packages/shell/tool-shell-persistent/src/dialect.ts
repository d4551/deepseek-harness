/**
 * The facts a persistent shell states differently: how a command is wrapped and
 * quoted for the PTY, how the shell is initialized, how a settled command is
 * recognized, and the model-facing names and advice that mention the shell.
 * Everything the two shells state identically stays in `index.ts`.
 * @module @deepseek-ai/dsh-tool-shell-persistent/src/dialect
 */

import type { TerminalSendResult } from '@deepseek-ai/dsh-terminal'

/** The shells this tool can drive; a composition selects exactly one per mount. */
export type ShellDialectName = 'bash' | 'pwsh'

/** Start and end sentinels bracketing one wrapped command in the PTY scrollback. */
export interface CommandMarkers {
  /** Printed before the command body runs. */
  start: string
  /** Printed after it, immediately followed by the decimal exit status. */
  end: string
}

/** One shell's PTY driving rules and model-facing vocabulary. */
export interface PersistentShellDialect {
  /** Registered tool name. */
  toolName: ShellDialectName
  /** Uppercase infix of the marker and timeout-code names, so a stray marker names its shell. */
  markerInfix: string
  /** Model-facing tool description when the composition supplies none. */
  defaultDescription: string
  /** Description of the `command` parameter. */
  commandDescription: string
  /** The search command named in the clipped-output note, in this shell's tooling. */
  searchCommand: string
  /** Told to the model after a shell reset, naming the shell the next call starts. */
  resetMessage: string
  /**
   * Input submitted once after spawn. For bash this only suppresses echo, keeping
   * the backend's own prompt so its prompt-based readiness detection still works;
   * for pwsh it installs {@link PersistentShellDialect.prompt}.
   */
  setup: string
  /** Prompt this dialect installs, or `undefined` when it keeps the backend's. */
  prompt?: string
  /**
   * Wrap one model command so its output is bracketed by markers and its exit
   * status is printed after the end marker.
   * @param command - the model's command text.
   * @param marker - the nonce markers for this call.
   * @returns one physical input line for the PTY.
   */
  wrapCommand(command: string, marker: CommandMarkers): string
  /**
   * Decide whether the shell finished the command without printing the end
   * marker — an `exec`, an interrupt, or an interactive child.
   * @param result - the settled send result.
   * @returns true when the tool should return the captured partial output.
   */
  settledWithoutMarker(result: TerminalSendResult): boolean
}

/**
 * Quote one string as a bash ANSI-C literal, so newlines and quotes ride one
 * physical input line.
 * @param value - the text to embed.
 * @returns the `$'...'` literal.
 */
function quoteForBash(value: string): string {
  return `$'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}'`
}

/**
 * Escape a command body for embedding in the pwsh wrapper's double-quoted string.
 * Backtick escapes keep every character literal: backtick first so the escapes
 * this function inserts are never re-escaped, `$` so no expansion happens at
 * wrapper construction, and `\r\n`/ESC so multi-line commands and raw control
 * bytes ride one physical input line without PSReadLine mangling.
 * @param value - the model's PowerShell command text.
 * @returns the escaped double-quoted-string body.
 */
function quoteForPwsh(value: string): string {
  return value
    .replaceAll('`', '``')
    .replaceAll('"', '`"')
    .replaceAll('$', '`$')
    .replaceAll('\r', '')
    .replaceAll('\n', '`n')
    .replaceAll('\x1b', '`e')
}

/** The pwsh prompt this tool installs over the backend bootstrap value. */
const PWSH_PROMPT = '__DSH_PERSISTENT_PWSH_PROMPT__ '

/**
 * Every dialect this tool drives, keyed by its `dialect` config value. The
 * `Record` key type makes a new member a compile error until it is stated here.
 */
export const PERSISTENT_SHELL_DIALECTS: Record<ShellDialectName, PersistentShellDialect> = {
  bash: {
    toolName: 'bash',
    markerInfix: 'BASH',
    defaultDescription: 'Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.',
    commandDescription: 'The bash command to run. Relative path is preferred in the command.',
    searchCommand: '`grep -n`',
    resetMessage: 'The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.',
    // Echo suppression only: the prompt stays the backend's own, so the
    // backend's prompt-based readiness detection keeps working.
    setup: 'stty -echo',
    wrapCommand(command, marker) {
      // Keep the wrapper on one physical line. An interactive bash prints PS2 for
      // embedded newlines before executing the buffer, which would leak terminal
      // prompts and marker source text into the model-facing result.
      return `printf '%s\\n' ${quoteForBash(marker.start)}; eval -- ${quoteForBash(command)}; __dsh_persistent_bash_status=$?; printf '%s%s\\n' ${quoteForBash(marker.end)} "$__dsh_persistent_bash_status"`
    },
    // The shell reads stdin again (its prompt, or a foreground child's own read)
    // without having printed the end marker.
    settledWithoutMarker: result => result.waitReason === 'stdin_read',
  },
  pwsh: {
    toolName: 'pwsh',
    markerInfix: 'PWSH',
    defaultDescription: 'Run commands in a persistent PowerShell shell. State, including the current directory and exported environment variables, persists across calls for this agent.',
    commandDescription: 'The PowerShell command to run. Relative path is preferred in the command.',
    searchCommand: 'Select-String',
    resetMessage: 'The persistent pwsh shell was reset; the next pwsh call starts from the workspace with a fresh current directory and environment.',
    // `[char]27`/`[char]7` build the OSC bytes at runtime because raw ESC
    // characters in submitted input are unreliable under PSReadLine.
    setup: `function prompt { [Console]::Write([char]27 + ']133;D;' + [int]$LASTEXITCODE + [char]7); '${PWSH_PROMPT}' }`,
    prompt: PWSH_PROMPT,
    wrapCommand(command, marker) {
      // Keep the wrapper on one physical line: PSReadLine renders the echoed
      // input, and a wrapped line would split the echo the extraction strips.
      // The echoed END nonce can never fabricate completion because the status
      // regex needs digits immediately after it and the echo continues with
      // quote characters.
      const body = quoteForPwsh(command)
      return `Write-Output '${marker.start}'; $LASTEXITCODE = $null; $__s = 1; try { Invoke-Expression "${body}"; $__ok = $? } catch { $__ok = $false }; if ($null -ne $LASTEXITCODE) { $__s = [int]$LASTEXITCODE } else { $__s = if ($__ok) { 0 } else { 1 } }; Write-Output ('${marker.end}' + $__s)`
    },
    settledWithoutMarker: result => result.viewport.endsWith(PWSH_PROMPT)
      || result.viewport.endsWith(`${PWSH_PROMPT}\r\n`)
      || result.viewport.endsWith(`${PWSH_PROMPT}\n`),
  },
}
