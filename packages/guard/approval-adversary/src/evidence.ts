/** Complete, session-owned evidence for one automatic approval decision. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestEvent, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'

/** Audit identity and complete model-visible authorization evidence. */
export interface ReviewEvidence {
  /** Open approval question owning this evidence. */
  approvalId: ApprovalRequestId
  /** Serialized human instructions, exact tool call, and justification. */
  text: string
}

/**
 * Bind a review to one open question, its exact call, and every human instruction.
 * @param req - approval request and its owning agent.
 * @param maxChars - maximum complete serialized evidence length.
 * @returns complete evidence, or the reason it cannot support review.
 */
export function reviewEvidence(req: ApprovalRequestEvent, maxChars: number): ReviewEvidence | string {
  if ([...req.agent.inbox.nextTurn, ...req.agent.inbox.nextStep].some(message => message.source.kind === 'user')) {
    return 'human instructions are waiting to be processed'
  }
  const events = req.agent.session.events
  const decided = new Set(events.filter(event => event.type === 'approval/decided').map(event => event.data.id))
  const [question, ...otherQuestions] = events.filter(event => event.type === 'approval/asked')
    .filter(event => !decided.has(event.data.id) && event.data.toolName === req.toolName
    && event.data.callId === req.callId && event.data.reason === req.reason)
  if (question === undefined || otherQuestions.length > 0) return 'approval question is missing or ambiguous'
  if (req.callId === undefined) return 'exact tool call is missing'
  const [call, ...otherCalls] = events.filter(event => event.type === 'tool/call')
    .filter(event => event.data.callId === req.callId)
  if (call === undefined || otherCalls.length > 0 || call.data.name !== req.toolName) {
    return 'tool identity is missing or ambiguous'
  }
  if (call.seq > question.seq) return 'tool call was not recorded before the approval question'
  if (req.reason === undefined || req.reason.trim().length === 0) return 'approval justification is missing'
  const instructions = humanInstructions(events)
  if (typeof instructions === 'string') return instructions
  const text = `Decide this approval request from the JSON record:\n${JSON.stringify({
    instructions,
    tool: req.toolName,
    call: { name: call.data.name, arguments: call.data.arguments },
    justification: req.reason,
  })}`
  if (text.length > maxChars) return 'complete approval evidence exceeds maxEvidenceChars'
  return { approvalId: question.data.id, text }
}

/** Preserve message and block order; non-text human evidence cannot be judged by a text-only record. */
function humanInstructions(events: readonly SessionEvent[]): string[][] | string {
  const instructions: string[][] = []
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const blocks: string[] = []
    for (const block of event.data.content) {
      if (block.type !== 'text') return 'human instruction contains evidence the reviewer cannot read'
      blocks.push(block.text)
    }
    instructions.push(blocks)
  }
  if (!instructions.some(blocks => blocks.some(text => text.trim().length > 0))) return 'human instruction is missing'
  return instructions
}
