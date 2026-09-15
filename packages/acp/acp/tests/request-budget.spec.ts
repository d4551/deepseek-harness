import { expect, it, onTestFinished } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse } from './harness.ts'
import { toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { acpStopReason } from '../../../subagent/subagent-acp/src/run.ts'

it('round-trips a real request limit through ACP without reporting completed work', async () => {
  const harness = await makeBridgeHarness({ script: [
    toolCallResponse('record-one', 'record_progress', {}, 'Completed one unit'),
    textResponse('Human-authorized continuation'),
  ] })
  onTestFinished(() => harness.dispose())
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
  const root = harness.ctx.agents.get(SessionId(sessionId))
  if (root === undefined) throw new Error('ACP did not publish its real agent')
  const policy = { policyId: 'test/acp-budget', maxAgentAttempts: 1, maxRootAttempts: 1 }
  let admitNext = true
  harness.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent !== root || message.source.kind !== 'user' || !admitNext) return
    harness.ctx.sessions.requestBudgets.offer(root.session, policy, message.id)
    admitNext = false
  })
  harness.ctx.on('agent/request', async ({ signal }, next) => {
    await harness.ctx.sessions.requestBudgets.reserve(root.session, root.session, policy, signal)
    return next()
  })
  let progress = 0
  harness.ctx.tools.register({
    name: 'record_progress', description: 'Record completed work.', parameters: { type: 'object' },
    output: { schema: { type: 'number' }, render: value => [{ type: 'text', text: String(value) }] },
    execute: async () => { progress += 1; return progress },
  })
  const first = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Do the authorized work' }] })
  expect(first.stopReason).toBe('max_turn_requests')
  expect(acpStopReason(first.stopReason)).toBe('request-budget')
  expect(progress).toBe(1)
  expect(harness.adapter.requests).toHaveLength(1)
  expect(root.session.events.findLast(event => event.type === 'turn/end'))
    .toMatchObject({ data: { reason: { kind: 'request-budget' } } })
  const withoutAdmission = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'Continue' }] })
  expect(withoutAdmission.stopReason).toBe('max_turn_requests')
  expect(harness.adapter.requests).toHaveLength(1)
  admitNext = true
  const resumed = await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'I authorize more work' }] })
  expect(resumed.stopReason).toBe('end_turn')
  expect(acpStopReason(resumed.stopReason)).toBe('completed')
  expect(harness.adapter.requests).toHaveLength(2)
  expect(root.session.events.filter(event => event.type === 'request/attempt')).toHaveLength(2)
  expect(root.session.events.filter(event => event.type === 'request/episode')).toHaveLength(2)
})
