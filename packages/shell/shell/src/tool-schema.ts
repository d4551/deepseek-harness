/**
 * The model-facing call and result contract the shell tool Consumers publish
 * for the `bash` and `pwsh` tools: the parameters that describe
 * execution rather than a dialect, the canonical result schema and the
 * projection that fills it, the argument checks the parameter schema cannot
 * express, and the sandbox-escalation guidance both descriptions carry. A
 * consumer of one tool's output must accept the other's, so this text and
 * schema have one home; each tool states only its own dialect (its name, its
 * command vocabulary, and any platform note).
 * @module dsh-shell/tool-schema
 */

import type { SandboxEnforcement, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { ShellRunResult } from './types.ts'

/** The execution arguments every shell tool accepts, before dialect-specific checks. */
export interface ShellToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  justification?: string
}

/**
 * Reject the argument values the parameter schema cannot express: empty
 * command or description text, a non-positive timeout, and the escalation
 * pairing (`sandbox_permissions` ⇔ `justification`, both non-empty) that both
 * enforcing families validate identically.
 * @param args - the parsed arguments of one tool call.
 * @throws Error naming the argument the model must correct.
 */
export function validateShellToolArgs(args: ShellToolArgs): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string')
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string')
  }
  if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
    throw new Error(`invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`)
  }
  validateEscalationArgs(args.sandbox_permissions, args.justification)
}

/**
 * The same-turn escalation protocol, stated to the model once. A tool appends
 * it to its description only when the composition advertises escalation
 * targets; without a confining executor the fields do not exist and the
 * guidance would describe an unavailable move.
 */
export const SHELL_ESCALATION_GUIDANCE = 'Attempting a command the sandbox may deny is safe and expected: run it and read the '
  + 'marker rather than assuming the denial. When a command is denied and a wider mode would let it '
  + 'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry '
  + 'the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) '
  + 'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the '
  + 'approval prompt raised by that retry is how the user consents. If the session states approval '
  + 'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. '
  + 'Never escalate speculatively: ground the request in a real denial — normally the one this command '
  + 'just hit; escalating up front is fine only when this session already denied the same access. '
  + 'A rejected escalation is final for that command — stop and explain, never work around '
  + 'it — but it does not forbid attempting or escalating other commands later.'

/** Per-call timeout override; the executor still applies its configured default and cap. */
export const SHELL_TIMEOUT_PARAMETER = {
  type: 'number',
  description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
} as const

/** Per-call working directory; the session workspace is the default. */
export const SHELL_WORKDIR_PARAMETER = {
  type: 'string',
  description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
} as const

/** Background execution, advertised only when the deployment enables it. */
export const SHELL_BACKGROUND_PARAMETER = {
  type: 'boolean',
  description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
} as const

/** The justification a sandbox escalation requires, advertised with it. */
export const SHELL_JUSTIFICATION_PARAMETER = {
  type: 'string',
  description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
} as const

/**
 * The wider-mode request, enumerated over the escalation targets this
 * composition advertises.
 * @param escalationModes - the modes a call may request; never empty at an advertised parameter.
 * @returns the parameter schema for `sandbox_permissions`.
 */
export function shellEscalationParameter(escalationModes: readonly SandboxMode[]): {
  type: 'string'
  enum: SandboxMode[]
  description: string
} {
  return {
    type: 'string',
    enum: [...escalationModes],
    description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
  }
}

/** The background-handle properties of the shell tools' output union. */
const BACKGROUND_OUTPUT_PROPERTIES = {
  kind: { type: 'string', required: true, const: 'background' },
  jobId: { type: 'string', required: true },
} as const

/**
 * The canonical result of one shell tool call: a background acknowledgement
 * carrying its job id, or the complete foreground outcome. Both tools publish
 * this exact schema, so a consumer of one accepts the other.
 */
export const SHELL_TOOL_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: BACKGROUND_OUTPUT_PROPERTIES,
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'foreground' },
        exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        timedOut: { type: 'boolean', required: true },
        aborted: { type: 'boolean', required: true },
        timeoutMs: { type: 'number', required: true },
        stdout: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            text: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            spillPath: { type: 'string' },
          },
        },
        stderr: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            text: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            spillPath: { type: 'string' },
          },
        },
        sandbox: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            denied: { type: 'boolean', required: true },
            enforcement: { type: 'string' },
            runnerFailed: { type: 'boolean' },
          },
        },
      },
    },
  ],
} as const

/** One collected stream as the canonical result states it. */
export interface CanonicalShellStream {
  text: string
  truncated: boolean
  /** Full-stream spill file, present only when truncation produced one. */
  spillPath?: string
}

/**
 * The foreground value {@link SHELL_TOOL_OUTPUT_SCHEMA} declares, without the
 * `kind` tag the tool prepends.
 */
export interface CanonicalShellResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: CanonicalShellStream
  stderr: CanonicalShellStream
  /** Sandbox execution facts, absent for an unsandboxed executor. */
  sandbox?: {
    mode: SandboxMode
    denied: boolean
    enforcement?: SandboxEnforcement
    runnerFailed?: boolean
  }
}

/**
 * Detach the executor DTO from readonly Service Definition types into the
 * plain JSON data {@link SHELL_TOOL_OUTPUT_SCHEMA} declares for a foreground
 * call; the caller prepends its `kind`.
 * @param result - the settled foreground run from the executor.
 * @returns the canonical foreground result value, absent fields omitted.
 */
export function canonicalShellResult(result: ShellRunResult): CanonicalShellResult {
  const output = (stream: ShellRunResult['stdout']): CanonicalShellStream => ({
    text: stream.text,
    truncated: stream.truncated,
    ...stream.spillPath !== undefined ? { spillPath: stream.spillPath } : {},
  })
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: output(result.stdout),
    stderr: output(result.stderr),
    ...result.sandbox !== undefined ? {
      sandbox: {
        mode: result.sandbox.mode,
        denied: result.sandbox.denied,
        ...result.sandbox.enforcement !== undefined ? { enforcement: result.sandbox.enforcement } : {},
        ...result.sandbox.runnerFailed !== undefined ? { runnerFailed: result.sandbox.runnerFailed } : {},
      },
    } : {},
  }
}
