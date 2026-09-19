import { describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { PendingApproval } from '../src/client/contract/slots.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

function alreadyAbortedWithoutReason(): AbortSignal {
  const controller = new AbortController()
  controller.abort(new Error('unused'))
  Object.defineProperty(controller.signal, 'reason', { configurable: true, value: undefined })
  return controller.signal
}

describe('PendingApproval Thrown reject', () => {
  it('resolves once, removes its abort listener, and ignores later Thrown abort cleanup', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = new PendingApproval(SessionId('s1'), {
      toolName: 'bash',
      callId: ToolCallId('call-1'),
      reason: 'needs access',
      signal: controller.signal,
    })

    await pending.answer('allowed-once')

    await expect(pending.result).resolves.toBe('allowed-once')
    expect(pending.sessionId).toBe(SessionId('s1'))
    expect(pending.toolName).toBe('bash')
    expect(pending.callId).toBe(ToolCallId('call-1'))
    expect(pending.reason).toBe('needs access')
    expect(remove).toHaveBeenCalledOnce()
    expect(() => { pending.abort(new Error('late')) }).not.toThrow()
    expect(() => { pending.delegate() }).not.toThrow()
    await expect(pending.answer('rejected')).rejects.toThrow(/already settled/)
  })

  it('rejects with an already-aborted signal Thrown reason', async () => {
    const controller = new AbortController()
    const reason = new Error('host cancelled')
    controller.abort(reason)

    const pending = new PendingApproval(SessionId('s1'), {
      toolName: 'read',
      signal: controller.signal,
    })

    await expect(pending.result).rejects.toBe(reason)
  })

  it('uses a stable fallback when an abort signal supplies no Thrown reason', async () => {
    const pending = new PendingApproval(SessionId('s1'), {
      toolName: 'read',
      signal: alreadyAbortedWithoutReason(),
    })

    await expect(pending.result).rejects.toThrow('approval request was aborted')
  })

  it('rejects an unanswered request with an explicit Thrown reason', async () => {
    const pending = new PendingApproval(SessionId('s1'), { toolName: 'write' })
    const reason = 'scope released'

    pending.abort(reason)

    await expect(pending.result).rejects.toBe(reason)
    expect(pending.isDelegation(reason)).toBe(false)
  })

  it('rejects an unanswered request with the delegation Thrown marker', async () => {
    const pending = new PendingApproval(SessionId('s1'), { toolName: 'write' })
    const settled = pending.result.then(undefined, (reason: Thrown) => reason)

    pending.delegate()

    const reason = await settled
    expect(pending.isDelegation(reason)).toBe(true)
    expect(() => { pending.delegate() }).not.toThrow()
    expect(() => { pending.abort('late') }).not.toThrow()
  })

  it('wraps a non-Error answer settlement Thrown with its cause', async () => {
    const failure = 'resolve failed'
    const completion = Promise.withResolvers<'allowed-once' | 'rejected'>()
    const withResolvers = vi.spyOn(Promise, 'withResolvers').mockImplementationOnce(() => ({
      promise: completion.promise,
      resolve: () => { throw failure },
      reject: completion.reject,
    }))
    const pending = new PendingApproval(SessionId('s1'), { toolName: 'write' })
    withResolvers.mockRestore()

    const settlement = await pending.answer('allowed-once').then(undefined, (error: Thrown) => error)

    if (!(settlement instanceof Error)) throw new Error('answer settlement must be Error')
    expect(settlement.message).toBe('pending approval settlement failed')
    expect(settlement.cause).toBe(failure)
    completion.resolve('allowed-once')
    await expect(pending.result).resolves.toBe('allowed-once')
  })
})
