/** Stream framing and full-output limits remain enforceable independently of verdict text. */

import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ALLOW_TEXT, EXPLICIT, harness, notices, reply } from './review-support.ts'

it('keeps distinct output blocks separate when validating the two-line protocol', async () => {
  const { ctx, req, agent } = await harness(EXPLICIT, [
    { type: 'block-end', index: 0, block: { type: 'text', text: 'VERDICT: ALLOW' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'REASON: the human requested the build' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await expect(ctx.approval.request(req)).resolves.toBe('allowed-once')
  expect(notices(agent)[0]?.text).toBe('Adversarial approval review allowed "bash": the human requested the build')
})

it.each([
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('unexpected'), name: 'bash', arguments: '{}' } },
] satisfies StreamChunk[])('rejects unsupported $type content before parsing ALLOW', async (chunk) => {
  const { ctx, req, agent } = await harness(EXPLICIT, [chunk, ...reply(ALLOW_TEXT)])
  await expect(ctx.approval.request(req)).resolves.toBe('rejected')
  expect(notices(agent)[0]?.text).toContain('review model returned unsupported content')
})

it.each([0, 1])('enforces the complete serialized stream bound with %s excess characters', async (excess) => {
  const chunks = reply(ALLOW_TEXT)
  const empty: StreamChunk = { type: 'block-end', index: 1, block: { type: 'reasoning', text: '' } }
  const baseSize = [...chunks, empty].reduce((sum, chunk) => sum + JSON.stringify(chunk).length, 0)
  const reasoning: StreamChunk = { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'x'.repeat(32_768 - baseSize + excess) } }
  const { ctx, req, agent } = await harness(EXPLICIT, [reasoning, ...chunks])
  await expect(ctx.approval.request(req)).resolves.toBe(excess === 0 ? 'allowed-once' : 'rejected')
  if (excess === 1) expect(notices(agent)[0]?.text).toContain('review stream exceeded its size limit')
})

it.each([{ provider: ' ', model: 'm' }, { provider: 'agent-route', model: ' ' }])('rejects an unusable inherited route: %j', async (config) => {
  const { ctx, req, agent, reviewer } = await harness({ enabled: true })
  agent.session.append('request/header', { header: { config }, reason: 'initial' })
  await expect(ctx.approval.request(req)).resolves.toBe('rejected')
  expect(reviewer.requests).toEqual([])
  expect(notices(agent)[0]?.text).toContain('no model route is available for approval review')
})
