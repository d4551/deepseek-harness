import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { sdkChildOutcome } from '../src/run.ts'

it('preserves the SDK child request-budget outcome without fabricating failure diagnostics', () => {
  const id = SessionId('sdk-budget')
  const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Work' }] })
  const reason: TurnEndReason = { kind: 'request-budget', budget: {
    version: 1, policyId: 'test/sdk-budget', rootSessionId: id, actorSessionId: id,
    userMessageId: human.id, actorAttempts: 32, rootAttempts: 32, maxAgentAttempts: 32, maxRootAttempts: 64,
  } }
  expect(sdkChildOutcome(structuredClone(reason))).toEqual({ stopReason: 'request-budget' })
  const failed = sdkChildOutcome({ kind: 'error', error: { code: 'UNKNOWN', message: 'Failure' } })
  expect(failed.stopReason).toBe('error')
  expect(failed.diagnostic).toContain('child-error')
})
