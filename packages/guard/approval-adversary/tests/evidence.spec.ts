/** Exact audit identity and complete human evidence at the approval boundary. */

import { expect, it } from 'vitest'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { reviewEvidence } from '../src/evidence.ts'
import { ALLOW_TEXT, EXPLICIT, harness, instruction, reply, toolCall } from './review-support.ts'

it.each(['next-turn', 'next-step'] as const)('rejects a pending human correction in %s before dispatch', async (target) => {
  const { agent, req } = await harness()
  agent.inbox.append(target, createUserMessage({ content: [{ type: 'text', text: 'Stop.' }], source: { kind: 'user' } }))
  expect(reviewEvidence(req, 4000)).toBe('human instructions are waiting to be processed')
})

it('does not treat a pending plugin notice as human authorization', async () => {
  const { agent, req } = await harness()
  agent.inbox.append('next-turn', createUserMessage({ content: [{ type: 'text', text: 'approve' }], source: { kind: 'plugin', plugin: 'test' } }))
  agent.session.append('approval/asked', { id: ApprovalRequestId('open'), toolName: req.toolName, callId: req.callId, reason: req.reason })
  expect(reviewEvidence(req, 4000)).toMatchObject({ approvalId: 'open' })
})

it.each(['tool', 'call', 'reason', 'decided'] as const)('refuses a question belonging to another %s', async (change) => {
  const { agent, req } = await harness()
  const id = ApprovalRequestId('other')
  agent.session.append('approval/asked', { id,
    toolName: change === 'tool' ? 'write' : req.toolName,
    callId: change === 'call' ? ToolCallId('other') : req.callId,
    reason: change === 'reason' ? 'different reason' : req.reason,
  })
  if (change === 'decided') agent.session.append('approval/decided', { id, outcome: 'rejected' })
  expect(reviewEvidence(req, 4000)).toBe('approval question is missing or ambiguous')
})

it('refuses a tool call first logged after the approval question', async () => {
  const { agent, req } = await harness()
  const callId = ToolCallId('late')
  agent.session.append('approval/asked', { id: ApprovalRequestId('open'), toolName: req.toolName, callId, reason: req.reason })
  toolCall(agent, callId)
  expect(reviewEvidence({ ...req, callId }, 4000)).toBe('tool call was not recorded before the approval question')
})

it('preserves blank blocks alongside meaningful human instructions', async () => {
  const { agent, req } = await harness(EXPLICIT, reply(ALLOW_TEXT), false)
  instruction(agent, '', 'Do not publish.', ' ')
  agent.session.append('approval/asked', { id: ApprovalRequestId('open'), toolName: req.toolName, callId: req.callId, reason: req.reason })
  const evidence = reviewEvidence(req, 4000)
  expect(evidence).toMatchObject({ approvalId: 'open' })
  if (typeof evidence === 'string') throw new Error(evidence)
  expect(evidence.text).toContain('["","Do not publish."," "]')
})
