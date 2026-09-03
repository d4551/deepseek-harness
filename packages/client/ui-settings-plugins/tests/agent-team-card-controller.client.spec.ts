/**
 * The Agent Team card's controller: the two capacities it edits, and how
 * their drafts settle into one save pass.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentTeamCardController, type AgentTeamSettings } from '../src/client/agent-team-card-controller.ts'
import { acceptWrites } from './scope-stubs.client.ts'

describe('AgentTeamCardController', () => {
  it('renders the served capacities and rejects a non-numeric draft', () => {
    const host = stubSettingsScope<AgentTeamSettings>()
    const controller = new AgentTeamCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { maxMembers: 16, maxTasks: 256 },
      base: { maxMembers: 16, maxTasks: 256 },
      user: {},
    })
    const face = controller.inject()

    expect(face.hooks.agentTeamCard.getSnapshot().maxMembers.text).toBe('16')
    expect(face.hooks.agentTeamCard.getSnapshot().maxTasks.text).toBe('256')

    face.edit('maxMembers', 'lots')
    const blocked = face.hooks.agentTeamCard.getSnapshot()
    expect(blocked.maxMembers.invalid).toBe(true)
    expect(blocked.invalid).toBe(true)
  })

  it('saves both capacities together', async () => {
    const host = stubSettingsScope<AgentTeamSettings>()
    acceptWrites(host)
    const controller = new AgentTeamCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('maxMembers', ' 24 ')
    face.edit('maxTasks', '512')
    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledTimes(2) })

    expect(host.set.mock.calls).toEqual([['maxMembers', 24], ['maxTasks', 512]])
    expect(face.hooks.agentTeamCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
  })

  it('stages a clear so saving lets a capacity re-inherit the composed profile', async () => {
    const host = stubSettingsScope<AgentTeamSettings>()
    acceptWrites(host)
    const controller = new AgentTeamCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { maxMembers: 4, maxTasks: 32 },
      base: { maxMembers: 16, maxTasks: 256 },
      user: { maxMembers: 4, maxTasks: 32 },
    })
    const face = controller.inject()

    face.resetField('maxMembers')
    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledWith('maxMembers') })

    expect(host.set).not.toHaveBeenCalled()
  })

  it('reports a read-only document so the card can disable its controls', () => {
    const host = stubSettingsScope<AgentTeamSettings>()
    const controller = new AgentTeamCardController(host.scope)

    host.publish({ status: 'ready', writable: false, value: { maxMembers: 16 } })

    expect(controller.inject().hooks.agentTeamCard.getSnapshot().writable).toBe(false)
  })

  it('renders nothing while a profile without a team serves no such namespace', () => {
    const host = stubSettingsScope<AgentTeamSettings>()
    const controller = new AgentTeamCardController(host.scope)

    expect(controller.inject().hooks.agentTeamCard.getSnapshot().available).toBe(false)
  })
})
