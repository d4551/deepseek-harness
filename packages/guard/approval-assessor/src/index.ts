/**
 * Approval assessor guard plugin. Hooks the `approval/request` waterfall to
 * detect work-avoidance approval requests (asking permission to skip, defer,
 * or soften tasks the user already authorized) and rejects them with a
 * redirect to the original user instructions. Legitimate safety gates
 * (sandbox escalation, destructive operations) pass through untouched.
 *
 * Toggleable via settings (`approval-assessor` namespace) or composition
 * config. When disabled, the listener delegates every request to the next
 * answerer without inspection.
 * @module @deepseek-ai/dsh-approval-assessor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'

export const name = 'approval-assessor'
export const inject = ['approval']

/**
 * Evasion patterns in approval reasons: phrases that signal the agent is
 * asking permission to avoid work the user already instructed it to do.
 * Each pattern is matched case-insensitively against the approval reason.
 */
const EVASION_PATTERNS: readonly RegExp[] = [
  /\bshould\s+i\s+(skip|defer|postpone|avoid|omit)\b/i,
  /\bcan\s+i\s+(skip|defer|postpone|avoid|omit)\b/i,
  /\bmay\s+i\s+(skip|defer|postpone|avoid|omit)\b/i,
  /\bdo\s+you\s+want\s+me\s+to\s+(skip|defer|postpone|avoid|omit)\b/i,
  /\bwould\s+you\s+like\s+me\s+to\s+(skip|defer|postpone|avoid|omit)\b/i,
  /\bshall\s+i\s+(skip|defer|postpone|avoid|omit)\b/i,
  /\bis\s+it\s+ok(?:ay)?\s+to\s+(skip|defer|postpone|avoid|omit)\b/i,
  /\bpermission\s+to\s+(skip|defer|postpone|avoid|omit)\b/i,
  /\bask(ing)?\s+(for\s+)?permission\b/i,
  /\bnot\s+(my|mine)\b.*\b(code|change|fix|work|task)\b/i,
  /\bpre[- ]?existing\b.*\b(issue|problem|bug|error|violation)\b/i,
  /\bout\s+of\s+scope\b/i,
  /\balready\s+(exists?|done|handled|fixed|implemented)\b/i,
  /\bknown\s+(limitation|issue|problem|bug)\b/i,
  /\bfuture\s+work\b/i,
  /\bseparate\s+ticket\b/i,
  /\btoo\s+risky\b/i,
  /\bnot\s+worth\s+fixing\b/i,
  /\bgood\s+enough\b/i,
  /\bleave\s+(?:(?:it|this|that|them)\s+)?as[- ]?is\b/i,
  /\bskip\s+for\s+now\b/i,
]

/**
 * Tool names whose approval requests are ALWAYS legitimate safety gates,
 * never work-avoidance. These pass through regardless of reason text.
 */
const SAFETY_GATE_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'write',
  'edit',
])

/** Settings namespace for this plugin. */
const NS = settingsNamespace('approval-assessor')

/** Plugin configuration, shared between composition entry and settings. */
export interface Config {
  /** Whether the assessor is active. Default `true`. */
  enabled?: boolean
  /**
   * Additional evasion patterns (JavaScript regex source strings) appended
   * to the built-in set. Compiled at load time; invalid regex fails loud.
   */
  extraPatterns?: string[]
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  extraPatterns: z.array(z.string()).default([]),
})

/**
 * Build the complete evasion pattern set from built-ins plus user extras.
 * Invalid extra patterns fail loud at construction — a silent regex error
 * would let evasion through undetected.
 * @param extras - additional regex source strings from config.
 * @returns frozen array of compiled patterns.
 */
function buildPatterns(extras: readonly string[]): readonly RegExp[] {
  const compiled: RegExp[] = [...EVASION_PATTERNS]
  for (const source of extras) {
    // Fail loud: an invalid pattern here means misconfiguration, not a
    // runtime condition to degrade gracefully from.
    compiled.push(new RegExp(source, 'i'))
  }
  return Object.freeze(compiled)
}

/**
 * Extract the most recent user message text from session events. Returns
 * undefined when no user message exists (e.g., delegated subagent turns).
 * @param events - session events in log order.
 * @returns the last user message text, or undefined.
 */
function lastUserInstruction(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'user/message') {
      const data = event.data as { content?: Array<{ type: string; text?: string }> }
      const textBlock = data.content?.find(block => block.type === 'text')
      if (textBlock?.text !== undefined) return textBlock.text
    }
  }
  return undefined
}

/**
 * Determine whether an approval request is work-avoidance rather than a
 * legitimate safety gate. Safety-gate tools always pass through. For other
 * tools, the reason is tested against evasion patterns.
 * @param req - the approval request event.
 * @param patterns - compiled evasion patterns.
 * @returns true when the request should be rejected as evasion.
 */
function isEvasion(req: ApprovalRequestEvent, patterns: readonly RegExp[]): boolean {
  if (SAFETY_GATE_TOOLS.has(req.toolName)) return false
  const reason = req.reason
  if (reason === undefined || reason.length === 0) return false
  return patterns.some(pattern => pattern.test(reason))
}

/**
 * Build the rejection message directing the agent back to user instructions.
 * @param toolName - the tool whose approval was rejected.
 * @param instruction - the user's original instruction excerpt, if available.
 * @returns the model-facing rejection text.
 */
function rejectionMessage(toolName: string, instruction: string | undefined): string {
  const base = `Approval denied: the request to approve "${toolName}" appears to be `
    + 'work-avoidance, not a legitimate safety gate. Do not ask for permission '
    + 'to skip, defer, or soften work the user already instructed you to do. '
    + 'Refer to the user\'s original instructions and proceed.'
  if (instruction === undefined) return base
  const excerpt = instruction.length > 500 ? `${instruction.slice(0, 500)}…` : instruction
  return `${base}\n\nUser instruction: ${excerpt}`
}

/** Live configuration source: settings scope when attached, entry otherwise. */
interface ConfigSource {
  get(): Config
}

/**
 * Install the approval assessor. Registers a settings namespace (when the
 * settings service is available) and hooks the `approval/request` waterfall.
 * @param ctx - plugin context.
 * @param entry - composition entry config.
 */
export function apply(ctx: Context, entry: Config): void {
  let patterns = buildPatterns(entry.extraPatterns ?? [])
  let source: ConfigSource = { get: () => entry }

  installSettingsSection(ctx, NS, Config, entry, {
    setSource(current) { source = { get: current } },
    onChange() {
      const config = source.get()
      patterns = buildPatterns(config.extraPatterns ?? [])
    },
  })

  ctx.on('approval/request', async (req: ApprovalRequestEvent, next): Promise<ApprovalOutcome> => {
    const config = source.get()
    if (config.enabled === false) return next()
    if (!isEvasion(req, patterns)) return next()

    const instruction = lastUserInstruction(req.agent.session.events)

    // Inject the rejection as model-visible context so the agent sees WHY
    // it was denied and what to do instead. The waterfall outcome is
    // 'rejected' — the approval service logs the asked/decided audit pair.
    req.agent.inject(createUserMessage({
      content: [{ type: 'text', text: rejectionMessage(req.toolName, instruction) }],
      source: { kind: 'plugin', plugin: 'approval-assessor', form: 'notice', summary: 'evasion-rejected' },
    }))

    return 'rejected'
  })
}
