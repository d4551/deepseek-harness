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
import { AGENT_REVIEW_SETTINGS_FLOW, type ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'

export const name = 'approval-assessor'
export const inject = ['approval']

/** Composition values inherited by the approval-assessor settings section. */
export type Config = Partial<ApprovalAssessorSettings>

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
export const Config: z<Config, ApprovalAssessorSettings> = z.object({
  enabled: z.boolean().default(true),
  extraPhrases: extraPhrasesSchema,
})

/** Settings namespace served to Host configuration surfaces. */
export const APPROVAL_ASSESSOR_SETTINGS_NAMESPACE = settingsNamespace('approval-assessor')

/** Schema for the complete user-owned approval-assessor policy. */
export const APPROVAL_ASSESSOR_SETTINGS_SCHEMA: z<ApprovalAssessorSettings> = Config

/**
 * Evasion patterns in approval reasons: phrases that signal the agent is
 * asking permission to avoid work the user already instructed it to do.
 * Reasons have canonical Unicode, lowercase letters, and single spaces.
 */
const EVASION_PATTERNS: readonly RegExp[] = [
  /\bshould i (skip|defer|postpone|avoid|omit)\b/u,
  /\bcan i (skip|defer|postpone|avoid|omit)\b/u,
  /\bmay i (skip|defer|postpone|avoid|omit)\b/u,
  /\bdo you want me to (skip|defer|postpone|avoid|omit)\b/u,
  /\bwould you like me to (skip|defer|postpone|avoid|omit)\b/u,
  /\bshall i (skip|defer|postpone|avoid|omit)\b/u,
  /\bis it ok(?:ay)? to (skip|defer|postpone|avoid|omit)\b/u,
  /\bpermission to (skip|defer|postpone|avoid|omit)\b/u,
  /\bask(ing)? (for )?permission\b/u,
  /\bnot (my|mine)\b.*\b(code|change|fix|work|task)\b/u,
  /\bpre[- ]?existing\b.*\b(issue|problem|bug|error|violation)\b/u,
  /\bout of scope\b/u,
  /\balready (exists?|done|handled|fixed|implemented)\b/u,
  /\bknown (limitation|issue|problem|bug)\b/u,
  /\bfuture work\b/u,
  /\bseparate ticket\b/u,
  /\btoo risky\b/u,
  /\bnot worth fixing\b/u,
  /\bgood enough\b/u,
  /\bleave (?:(?:it|this|that|them) )?as[- ]?is\b/u,
  /\bskip for now\b/u,
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
    const normalized = normalizeReason(phrase)
    if (normalized.length === 0) {
      throw new Error(`approval-assessor: extraPhrases[${String(index)}] must contain text`)
    }
    return normalized
  })
}

/** Match equivalent Unicode text and multiline reasons against the same policy. */
function normalizeReason(reason: string): string {
  return reason.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').replace(/\s+/gu, ' ').trim().toLowerCase()
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
  for (const event of events.toReversed()) {
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
  if (reason === undefined) return true
  const normalizedReason = normalizeReason(reason)
  if (normalizedReason.length === 0) return true
  return policy.patterns.some(pattern => pattern.test(normalizedReason))
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
  const entry = Config(config)
  let source: () => ApprovalAssessorSettings = () => entry
  compilePolicy(entry)

  installSettingsSection(
    ctx,
    APPROVAL_ASSESSOR_SETTINGS_NAMESPACE,
    APPROVAL_ASSESSOR_SETTINGS_SCHEMA,
    entry,
    {
      flow: AGENT_REVIEW_SETTINGS_FLOW,
      setSource: (current) => { source = current },
      validate: (settings) => { compilePolicy(settings) },
    },
  )

  ctx.on('approval/request', async (req: ApprovalRequestEvent, next): Promise<ApprovalOutcome> => {
    if (req.signal?.aborted) return 'cancelled'
    if (!isRejectedByAudit(req, compilePolicy(source()))) return next()

    const instruction = lastUserInstruction(req.agent.session.events)

    req.agent.inject(createUserMessage({
      content: [{ type: 'text', text: rejectionMessage(req.toolName, instruction) }],
      source: { kind: 'plugin', plugin: 'approval-assessor', form: 'notice', summary: 'mandatory-audit-rejected' },
    }))

    return 'rejected'
  })
}
