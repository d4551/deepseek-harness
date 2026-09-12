/**
 * The pending-approval index of the dynamic registry, driven directly: the
 * runner suites only ever claim a request they just found, so the answer
 * for a request nobody armed and the walk past another Plugin's request
 * are pinned here.
 */
import { describe, expect, it } from 'vitest'
import { DynamicCordisRegistry } from '../src/registry.ts'
import type { DynamicCordisPendingRequest } from '../src/registry.ts'
import type { ApprovalRequestId, CordisDynamicPluginId } from '../src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

function pending(pluginId: string): DynamicCordisPendingRequest {
  return {
    agentId: 'S-a' as SessionId,
    pluginId: pluginId as CordisDynamicPluginId,
    packageId: 'pkg-1' as DynamicCordisPendingRequest['packageId'],
    pluginRunId: 'run-1' as DynamicCordisPendingRequest['pluginRunId'],
    mode: 'run',
    requiresApproval: true,
  }
}

describe('the pending-approval index', () => {
  it('claims a request once and answers nothing for one nobody armed', () => {
    const registry = new DynamicCordisRegistry()
    const id = registry.mintApprovalRequestId() as ApprovalRequestId
    registry.armRequest(id, pending('clock-1'))
    expect(registry.claimRequest(id)).toEqual(pending('clock-1'))
    expect(registry.claimRequest(id)).toBeUndefined()
    expect(registry.claimRequest('approval-99' as ApprovalRequestId)).toBeUndefined()
  })

  it('finds a Plugin request behind another Plugin request, and none once claimed', () => {
    const registry = new DynamicCordisRegistry()
    const first = registry.mintApprovalRequestId() as ApprovalRequestId
    const second = registry.mintApprovalRequestId() as ApprovalRequestId
    registry.armRequest(first, pending('clock-1'))
    registry.armRequest(second, pending('clock-2'))
    expect(registry.pendingRequestFor('clock-2' as CordisDynamicPluginId)).toBe(second)
    expect(registry.pendingRequestFor('clock-1' as CordisDynamicPluginId)).toBe(first)
    registry.claimRequest(second)
    expect(registry.pendingRequestFor('clock-2' as CordisDynamicPluginId)).toBeUndefined()
    expect(registry.peekRequest(first)).toEqual(pending('clock-1'))
  })
})
