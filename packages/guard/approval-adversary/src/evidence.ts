/** Complete, session-owned evidence for one automatic approval decision. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestEvent, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'

export interface ReviewEvidence {
  approvalId: ApprovalRequestId
  text: string
}

/** Bind a review to one open question, its exact call, and every human instruction. */
export function reviewEvidence(req: ApprovalRequestEvent, maxChars: number): ReviewEvidence | string {
  const events = req.agent.session.events
  const decided = new Set(events.flatMap(event => event.type === 'approval/decided' ? [event.data.id] : []))
  const questions = events.filter(event => event.type === 'approval/asked'
    && !decided.has(event.data.id) && event.data.toolName === req.toolName
    && event.data.callId === req.callId && event.data.reason === req.reason)
  const question = questions[0]
  if (questions.length !== 1 || question?.type !== 'approval/asked') return 'approval question is missing or ambiguous'
  if (req.callId === undefined) return 'exact tool call is missing'
  const calls = events.filter(event => event.type === 'tool/call' && event.data.callId === req.callId)
  const call = calls[0]
  if (calls.length !== 1 || call?.type !== 'tool/call' || call.data.name !== req.toolName) {
    return 'tool identity is missing or ambiguous'
  }
  if (call.seq >= question.seq) return 'tool call was not recorded before the approval question'
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
