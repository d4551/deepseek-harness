/** A completed model answer cannot authorize a replaced question or changed evidence. */

import { getEventListeners } from 'node:events'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import { Config } from '../src/policy.ts'
import { review } from '../src/review.ts'
import { ALLOW_TEXT, EXPLICIT, harness, instruction, reply } from './review-support.ts'

it.each(['identity', 'text', 'non-text'] as const)('rejects changed %s after a successful model response', async (change) => {
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const { ctx, agent, req } = await harness(EXPLICIT, async function* () {
    started.resolve(undefined)
    await release.promise
    yield * reply(ALLOW_TEXT)
  })
  const id = ApprovalRequestId('original')
  const question = { id, toolName: req.toolName, callId: req.callId, reason: req.reason }
  agent.session.append('approval/asked', question)
  const pending = review(ctx, req, Config(EXPLICIT))
  await started.promise
  if (change === 'identity') {
    agent.session.append('approval/decided', { id, outcome: 'rejected' })
    agent.session.append('approval/asked', { ...question, id: ApprovalRequestId('replacement') })
  }
  if (change === 'text') instruction(agent, 'Stop. Do not run the build.')
  if (change === 'non-text') agent.session.append('user/message', createUserMessage({
    content: [{ type: 'reasoning', text: 'Unreadable authorization evidence' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  release.resolve(undefined)
  await expect(pending).resolves.toEqual({ verdict: 'unavailable', reason: 'approval evidence changed during review' })
})

it('does not dispatch a review that is already cancelled', async () => {
  const { ctx, agent, req, reviewer } = await harness()
  agent.session.append('approval/asked', { id: ApprovalRequestId('cancelled'), toolName: req.toolName, callId: req.callId, reason: req.reason })
  await expect(review(ctx, { ...req, signal: AbortSignal.abort() }, Config(EXPLICIT))).resolves.toEqual({
    verdict: 'unavailable', reason: 'review was cancelled or exceeded timeoutMs',
  })
  expect(reviewer.requests).toEqual([])
})

it.each([{ provider: 'reviewer' }, { model: 'adversary' }])('cannot dispatch an incomplete direct review route: %j', async (route) => {
  const { ctx, agent, req, reviewer } = await harness()
  agent.session.append('approval/asked', { id: ApprovalRequestId('route'), toolName: req.toolName, callId: req.callId, reason: req.reason })
  await expect(review(ctx, req, Config({ enabled: true, ...route }))).resolves.toEqual({
    verdict: 'unavailable', reason: 'no model route is available for approval review',
  })
  expect(reviewer.requests).toEqual([])
})

it('releases the review cancellation listener after completion', async () => {
  const { ctx, req, reviewer } = await harness()
  await expect(ctx.approval.request(req)).resolves.toBe('allowed-once')
  const signal = reviewer.requests[0]?.signal
  if (signal === undefined) throw new Error('Review request has no deadline signal')
  expect(getEventListeners(signal, 'abort')).toEqual([])
})
