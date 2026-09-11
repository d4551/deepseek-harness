/** Bounded, tool-free model review over immutable approval evidence. */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type { ApprovalRequestEvent, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import { reviewEvidence } from './evidence.ts'
import type { ApprovalAdversarySettings } from './policy.ts'
import { MAX_REVIEW_CHARS, parseVerdict, REVIEW_INSTRUCTIONS, type ReviewResult } from './protocol.ts'

export const APPROVAL_ADVERSARY_TIMEOUT_CODE = 'APPROVAL_ADVERSARY_TIMEOUT'
export const APPROVAL_ADVERSARY_PLUGIN = 'approval-adversary'

export interface ApprovalAdversaryRequestEventData {
  readonly approvalId: ApprovalRequestId
  readonly toolName: string
  readonly route: { readonly provider: string; readonly model: string }
  readonly system: string
  readonly messages: Message[]
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact review request committed before provider dispatch. */
    'approval/adversary-request': ApprovalAdversaryRequestEventData
  }
}

function resolveRoute(settings: ApprovalAdversarySettings, session: Session) {
  if (settings.provider && settings.model) return { provider: settings.provider, model: settings.model }
  const header = session.events.findLast(event => event.type === 'request/header')
  return header?.type === 'request/header' ? header.data.header.config : undefined
}

/** Require an explicit successful terminal event and enforce a complete-stream bound. */
async function consume(ctx: Context, options: GenerateOptions): Promise<ReviewResult> {
  const assembler = new BlockAssembler()
  let finished = false
  let size = 0
  for await (const chunk of ctx.llm.stream(options)) {
    if (options.signal?.aborted) return { verdict: 'unavailable', reason: 'review was cancelled or exceeded timeoutMs' }
    size += JSON.stringify(chunk).length
    if (size > MAX_REVIEW_CHARS) return { verdict: 'unavailable', reason: 'review stream exceeded its size limit' }
    if (finished) return { verdict: 'unavailable', reason: 'review stream continued after its terminal event' }
    if (chunk.type === 'finish') {
      finished = true
      if (chunk.reason.kind !== 'stop') return { verdict: 'unavailable', reason: `review did not finish successfully: ${chunk.reason.kind}` }
    }
    if ((chunk.type === 'block-start' && !['text', 'reasoning'].includes(chunk.blockType))
      || (chunk.type === 'block-end' && !['text', 'reasoning'].includes(chunk.block.type))
      || chunk.type === 'tool-call-delta') return { verdict: 'unavailable', reason: 'review model returned unsupported content' }
    assembler.push(chunk)
  }
  if (!finished) return { verdict: 'unavailable', reason: 'review stream ended without a terminal event' }
  return parseVerdict(assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
}

/** Decide only evidence that remains unchanged through the entire review. */
export async function review(ctx: Context, req: ApprovalRequestEvent, settings: ApprovalAdversarySettings): Promise<ReviewResult> {
  const session = req.agent.session
  const evidence = reviewEvidence(req, settings.maxEvidenceChars)
  if (typeof evidence === 'string') return { verdict: 'unavailable', reason: evidence }
  const route = resolveRoute(settings, session)
  if (!route?.provider.trim() || !route.model.trim()) return { verdict: 'unavailable', reason: 'no model route is available for approval review' }
  const system = settings.instructions.length === 0 ? REVIEW_INSTRUCTIONS : `${REVIEW_INSTRUCTIONS}\n\n${settings.instructions}`
  const messages = [createUserMessage({ content: [{ type: 'text', text: evidence.text }], source: { kind: 'plugin', plugin: APPROVAL_ADVERSARY_PLUGIN } })]
  using lifetime = deadline(req.signal, settings.timeoutMs, APPROVAL_ADVERSARY_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({ ...route, messages, system, maxTokens: settings.maxOutputTokens,
    sessionId: session.id, purpose: 'approval-review', signal: lifetime.signal })
  session.append('approval/adversary-request', { approvalId: evidence.approvalId, toolName: req.toolName,
    route: { provider: route.provider, model: route.model }, system, messages, maxTokens: settings.maxOutputTokens })
  const expired: ReviewResult = { verdict: 'unavailable', reason: 'review was cancelled or exceeded timeoutMs' }
  const cancellation = Promise.withResolvers<ReviewResult>()
  const onAbort = () => { cancellation.resolve(expired) }
  lifetime.signal.addEventListener('abort', onAbort, { once: true })
  if (lifetime.signal.aborted) onAbort()
  const result = await Promise.race([consume(ctx, options), cancellation.promise])
    .finally(() => { lifetime.signal.removeEventListener('abort', onAbort) })
  if (lifetime.signal.aborted) return expired
  const current = reviewEvidence(req, settings.maxEvidenceChars)
  if (typeof current === 'string' || current.approvalId !== evidence.approvalId || current.text !== evidence.text) {
    return { verdict: 'unavailable', reason: 'approval evidence changed during review' }
  }
  return result
}
