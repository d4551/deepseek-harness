/** Notification work remains owned until the surface reports its result. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-presets/types'
import { AgentPresetSeatController } from '../src/client/seat-store.ts'
import { AgentPresetSurfaceUpdates } from '../src/client/surface-updates.ts'

describe('preset surface updates', () => {
  it('drains a held roster read, publishes its failure, and rejects further work after disposal', async () => {
    const roster = Promise.withResolvers<{ ok: true; value: AgentPresetRoster }>()
    const controller = new AgentPresetSeatController({ agentPresets: {
      list: () => roster.promise,
      select: (_sessionId, value) => Promise.resolve({ ok: true, value }),
    } }, () => undefined)
    const updates = new AgentPresetSurfaceUpdates()
    updates.load(controller)
    const closing = updates.dispose()
    expect(updates.dispose()).toBe(closing)
    let closed = false
    const observed = closing.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    roster.reject(new Error('roster connection ended'))
    await observed
    expect(closed).toBe(true)
    expect(controller.store.getSnapshot().error).toBe('roster connection ended')
    expect(() => { updates.load(controller) }).toThrow('surface updates disposed')
    expect(() => { updates.apply(controller) }).toThrow('surface updates disposed')
  })

  it('joins repeated selection notifications and retains a failed selection on the seat', async () => {
    const selection = Promise.withResolvers<{ ok: true; value: string }>()
    const calls: string[] = []
    const controller = new AgentPresetSeatController({ agentPresets: {
      list: () => Promise.resolve({ ok: true, value: { presets: [], authorable: false } }),
      select: (_sessionId, value) => { calls.push(value); return selection.promise },
    } }, () => ({ id: SessionId('notification-seat'), blank: true }))
    controller.stage('minimal')
    const updates = new AgentPresetSurfaceUpdates()
    updates.apply(controller)
    updates.apply(controller)
    const closing = updates.dispose()
    selection.reject(new Error('preset could not mount'))
    await closing
    expect(calls).toEqual(['minimal'])
    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, current: '', error: 'preset could not mount' })
  })

  it('publishes a synchronous session-reader failure rather than rejecting an unobserved callback', async () => {
    const controller = new AgentPresetSeatController({ agentPresets: {
      list: () => Promise.resolve({ ok: true, value: { presets: [], authorable: false } }),
      select: (_sessionId, value) => Promise.resolve({ ok: true, value }),
    } }, () => { throw new Error('session projection unavailable') })
    const updates = new AgentPresetSurfaceUpdates()
    updates.load(controller)
    await updates.dispose()
    expect(controller.store.getSnapshot().error).toBe('session projection unavailable')
  })
})
