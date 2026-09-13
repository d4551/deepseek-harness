/**
 * Automatic approval reviewer. An enabled review grants only a complete,
 * current, explicitly allowed request; every undecided request is rejected.
 * @module @deepseek-ai/dsh-approval-adversary
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { AGENT_REVIEW_SETTINGS_FLOW, type ApprovalOutcome, type ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { APPROVAL_ADVERSARY_SETTINGS_NAMESPACE, assertRoutePair, Config } from './policy.ts'
import type { ReviewResult } from './protocol.ts'
import { APPROVAL_ADVERSARY_PLUGIN, review } from './review.ts'

export { Config, APPROVAL_ADVERSARY_SETTINGS_NAMESPACE } from './policy.ts'
export type { ApprovalAdversarySettings } from './policy.ts'
export { REVIEW_INSTRUCTIONS } from './protocol.ts'
export { APPROVAL_ADVERSARY_PLUGIN, APPROVAL_ADVERSARY_TIMEOUT_CODE } from './review.ts'
export type { ApprovalAdversaryRequestEventData } from './review.ts'

export const name = 'approval-adversary'
export const inject = ['approval', 'llm']

/** Decision classes carried by model-visible review notices. */
export type AdversaryVerdict = ReviewResult['verdict']

/** Stable notice summaries consumed by the runtime invariant. */
export const VERDICT_SUMMARIES: Readonly<Record<AdversaryVerdict, string>> = {
  allowed: 'adversarial review: allowed',
  denied: 'adversarial review: denied',
  unavailable: 'adversarial review: unavailable',
}

function noticeText(tool: string, result: ReviewResult): string {
  if (result.verdict === 'allowed') return `Adversarial approval review allowed "${tool}": ${result.reason}`
  if (result.verdict === 'denied') return `Adversarial approval review denied "${tool}": ${result.reason}\n`
    + 'Do not resubmit the same request with a reworded justification. Return to the user\'s instructions and take the direct step they asked for.'
  return `Adversarial approval review could not decide "${tool}" (${result.reason}). The request was rejected. `
    + 'Continue with authorized work that needs no approval, or ask the user to resolve the missing authorization.'
}

/** Register user-owned policy and the automatic answerer. */
export function apply(ctx: Context, config: Config = {}): void {
  const entry = Config(config)
  assertRoutePair(entry)
  const lifecycle = new AbortController()
  ctx.effect(() => () => { lifecycle.abort() }, 'approval-adversary.lifecycle')
  let source = () => entry
  installSettingsSection(ctx, APPROVAL_ADVERSARY_SETTINGS_NAMESPACE, Config, entry, {
    flow: AGENT_REVIEW_SETTINGS_FLOW,
    setSource: (current) => { source = current },
    validate: assertRoutePair,
  })
  ctx.on('approval/request', async (req: ApprovalRequestEvent, next): Promise<ApprovalOutcome> => {
    if (req.signal?.aborted) return 'cancelled'
    const settings = source()
    if (!settings.enabled) return next()
    const policy = JSON.stringify(settings)
    const signal = req.signal === undefined ? lifecycle.signal : AbortSignal.any([req.signal, lifecycle.signal])
    let result = await review(ctx, { ...req, signal }, settings)
    if (signal.aborted) return 'cancelled'
    if (JSON.stringify(source()) !== policy) result = { verdict: 'unavailable', reason: 'approval policy changed during review' }
    req.agent.inject(createUserMessage({
      content: [{ type: 'text', text: noticeText(req.toolName, result) }],
      source: { kind: 'plugin', plugin: APPROVAL_ADVERSARY_PLUGIN, form: 'notice', summary: VERDICT_SUMMARIES[result.verdict] },
    }))
    return result.verdict === 'allowed' ? 'allowed-once' : 'rejected'
  })
}
