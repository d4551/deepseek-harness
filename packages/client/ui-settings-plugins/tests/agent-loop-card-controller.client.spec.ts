/**
 * The agent-loop card: one numeric field, disabled when the document is
 * read-only.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentLoopCardController, type AgentLoopSettings } from '../src/client/agent-loop-card-controller.ts'
import { acceptWrites } from './scope-stubs.client.ts'

describe('AgentLoopCardController', () => {
  it('saves the only field it owns', async () => {
    const host = stubSettingsScope<AgentLoopSettings>()
    acceptWrites(host)
    const controller = new AgentLoopCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { maxParallelToolCalls: 10 },
      base: { maxParallelToolCalls: 10 },
      user: {},
    })
    const face = controller.inject()

    face.edit('maxParallelToolCalls', '4')
    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledWith('maxParallelToolCalls', 4) })

    expect(face.hooks.agentLoopCard.getSnapshot()).toMatchObject({
      dirty: false,
      maxParallelToolCalls: { text: '4', overridden: true },
    })
  })

  it('reports a read-only document so the card can disable its controls', () => {
    const host = stubSettingsScope<AgentLoopSettings>()
    const controller = new AgentLoopCardController(host.scope)

    host.publish({ status: 'ready', writable: false, value: { maxParallelToolCalls: 10 } })

    expect(controller.inject().hooks.agentLoopCard.getSnapshot().writable).toBe(false)
  })
})
