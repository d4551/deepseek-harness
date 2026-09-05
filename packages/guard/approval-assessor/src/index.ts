/**
 * Approval assessor guard plugin. Hooks the `approval/request` waterfall to
 * detect work-avoidance approval requests (asking permission to skip, defer,
 * or soften tasks the user already authorized) and rejects them with a
 * redirect to the original user instructions. Every approval request is
 * screened before it can reach an answerer.
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

/** Composition values inherited by the approval-assessor settings section. */
export interface Config {
  /** Whether the assessor rejects work-avoidance approval reasons. */
  enabled?: boolean
  /** Additional case-insensitive literal phrases to screen. */
  extraPhrases?: string[]
}

/** User-owned approval-assessor policy, applied to every approval request. */
export interface ApprovalAssessorSettings {
  /** Whether the assessor rejects work-avoidance approval reasons. */
  enabled: boolean
  /** Additional case-insensitive literal phrases to screen. */
  extraPhrases: string[]
}

const MAX_EXTRA_PHRASES = 64
const MAX_EXTRA_PHRASE_LENGTH = 256

const extraPhrasesSchema = z.array(
  z.string().min(1).max(MAX_EXTRA_PHRASE_LENGTH),
).max(MAX_EXTRA_PHRASES).default([])

/** Plugin configuration schema with the mandatory audit enabled by default. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  extraPhrases: extraPhrasesSchema,
})

/** Settings namespace served to Host configuration surfaces. */
export const APPROVAL_ASSESSOR_SETTINGS_NAMESPACE = settingsNamespace('approval-assessor')

/** Schema for the complete user-owned approval-assessor policy. */
export const APPROVAL_ASSESSOR_SETTINGS_SCHEMA: z<ApprovalAssessorSettings> = z.object({
  enabled: z.boolean().default(true),
  extraPhrases: extraPhrasesSchema,
})

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

/** Compiled policy used by the request waterfall. */
interface ApprovalPolicy {
  enabled: boolean
  patterns: readonly RegExp[]
  phrases: readonly string[]
}

/**
 * Normalize user-provided literal phrases for case-insensitive matching.
 * @param phrases - bounded phrases accepted by the settings schema.
 * @returns the normalized phrases.
 */
function normalizeExtraPhrases(phrases: readonly string[]): readonly string[] {
  return phrases.map((phrase, index) => {
    const normalized = phrase.trim().toLowerCase()
    if (normalized.length === 0) {
      throw new Error(`approval-assessor: extraPhrases[${String(index)}] must contain text`)
    }
    return normalized
  })
}

/**
 * Compile one complete approval policy after schema validation.
 * @param settings - resolved user-owned settings.
 * @returns the active screening policy.
 */
function compilePolicy(settings: ApprovalAssessorSettings): ApprovalPolicy {
  return {
    enabled: settings.enabled,
    patterns: EVASION_PATTERNS,
    phrases: normalizeExtraPhrases(settings.extraPhrases),
  }
}

/**
 * Extract the most recent human instruction from session events. Only
 * `source.kind === 'user'` messages qualify: the user-role log also carries
 * plugin snapshots (runtime context, tool reminders) and tool results, and
 * quoting one of those back would redirect the model to a plugin's own text
 * instead of the task. Returns undefined when the session holds no human
 * message, as a delegated subagent turn does.
 * @param events - session events in log order.
 * @returns the last human instruction text, or undefined.
 */
function lastUserInstruction(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    const textBlock = event.data.content.find(block => block.type === 'text')
    if (textBlock?.text !== undefined) return textBlock.text
  }
  return undefined
}

/**
 * Determine whether the mandatory approval audit rejects a request. Missing
 * justification is rejected, and a supplied justification is rejected when
 * it matches a work-avoidance pattern.
 * @param req - the approval request event.
 * @param policy - the active screening policy.
 * @returns true when the request cannot proceed to an answerer.
 */
function isRejectedByAudit(req: ApprovalRequestEvent, policy: ApprovalPolicy): boolean {
  if (!policy.enabled) return false
  const reason = req.reason
  if (reason === undefined || reason.trim().length === 0) return true
  const normalizedReason = reason.toLowerCase()
  return policy.patterns.some(pattern => pattern.test(reason))
    || policy.phrases.some(phrase => normalizedReason.includes(phrase))
}

/**
 * Build the rejection message directing the agent back to user instructions.
 * @param toolName - the tool whose approval was rejected.
 * @param instruction - the user's original instruction excerpt, if available.
 * @returns the model-facing rejection text.
 */
function rejectionMessage(toolName: string, instruction: string | undefined): string {
  const base = `Mandatory approval audit denied "${toolName}": the justification is missing or `
    + 'indicates work-avoidance. Do not ask for permission '
    + 'to skip, defer, or soften work the user already instructed you to do. '
    + 'Refer to the user\'s original instructions and proceed.'
  if (instruction === undefined) return base
  const excerpt = instruction.length > 500 ? `${instruction.slice(0, 500)}…` : instruction
  return `${base}\n\nUser instruction: ${excerpt}`
}

/**
 * Install the mandatory approval assessor.
 * @param ctx - plugin context.
 * @param config - initial policy inherited by the user-owned settings section.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const entry: ApprovalAssessorSettings = {
    enabled: config.enabled ?? true,
    extraPhrases: config.extraPhrases ?? [],
  }
  let source: () => ApprovalAssessorSettings = () => entry
  let policy = compilePolicy(entry)
  const refreshPolicy = (): void => {
    policy = compilePolicy(source())
  }

  installSettingsSection(
    ctx,
    APPROVAL_ASSESSOR_SETTINGS_NAMESPACE,
    APPROVAL_ASSESSOR_SETTINGS_SCHEMA,
    entry,
    {
      setSource: (current) => { source = current },
      validate: (settings) => { compilePolicy(settings) },
      onChange: refreshPolicy,
    },
  )

  ctx.on('approval/request', async (req: ApprovalRequestEvent, next): Promise<ApprovalOutcome> => {
    refreshPolicy()
    if (!isRejectedByAudit(req, policy)) return next()

    const instruction = lastUserInstruction(req.agent.session.events)

    // Inject the rejection as model-visible context so the agent sees WHY
    // it was denied and what to do instead. The waterfall outcome is
    // 'rejected' — the approval service logs the asked/decided audit pair.
    req.agent.inject(createUserMessage({
      content: [{ type: 'text', text: rejectionMessage(req.toolName, instruction) }],
      source: { kind: 'plugin', plugin: 'approval-assessor', form: 'notice', summary: 'mandatory-audit-rejected' },
    }))

    return 'rejected'
  })
}
