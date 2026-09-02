/**
 * The subagent model-selection card under contention: duplicate actions,
 * mid-flight directory faults, late results, and writes after disposal.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView, SubagentModelSelectionSettings } from '@deepseek-ai/dsh-api-remotes/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  SubagentModelSelectionCardController,
} from '../src/client/subagent-model-selection-card-controller.ts'
import { modelCatalogStub } from './model-catalog-stub.client.ts'
import { deferred } from './scope-stubs.client.ts'

describe('SubagentModelSelectionCardController', () => {
  it('ignores duplicate actions and late save results', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const catalog = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const write = deferred<undefined>()
    const mutate = vi.fn(async (ops: readonly SettingsPathOpView[]) => {
      await write.promise
      const enabled = ops.find(op => op.path[0] === 'enabled')
      const allowedModels = ops.find(op => op.path[0] === 'allowedModels')
      host.publish({ value: {
        enabled: enabled?.op === 'set' ? enabled.value as boolean : false,
        allowedModels: allowedModels?.op === 'set' ? allowedModels.value as never[] : [],
      } })
    })
    const controller = new SubagentModelSelectionCardController({ ...host.scope, mutate }, catalog.api)
    const face = controller.inject()

    face.save()
    face.toggleModel('alpha\0fast')
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    face.save()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().catalogStatus).toBe('ready') })
    face.save()
    face.toggleModel('alpha\0fast')
    face.save()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot().saving).toBe(true)
    face.toggleEnabled()
    face.toggleModel('alpha\0fast')
    face.save()
    face.discard()
    controller.dispose()
    write.resolve(undefined)
    await write.promise
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('reports a directory carrier fault as a failed read rather than an unhandled rejection', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    host.publish({ status: 'ready', writable: true, value: { enabled: true, allowedModels: [] }, user: {} })
    const pending = deferred<never>()
    const controller = new SubagentModelSelectionCardController(
      host.scope,
      { modelCatalog: () => pending.promise },
    )
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().catalogStatus).toBe('loading')
    })

    pending.reject(new Error('no gateway directory mounted'))
    await expect(controller.background).resolves.toBeUndefined()

    expect(face.hooks.subagentModelSelectionCard.getSnapshot().catalogStatus).toBe('error')
  })

  it('ignores duplicate directory loads and late resolve or reject results', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })

    const pending = deferred<never>()
    const models = vi.fn(() => pending.promise)
    const controller = new SubagentModelSelectionCardController(host.scope, { modelCatalog: models })
    const face = controller.inject()
    face.toggleEnabled()
    face.retryCatalog()
    expect(models).toHaveBeenCalledOnce()
    controller.dispose()
    const settled = controller.background
    pending.reject(new Error('late failure'))
    await expect(settled).resolves.toBeUndefined()

    const pendingResolve = deferred<never>()
    const resolving = new SubagentModelSelectionCardController(
      host.scope,
      { modelCatalog: () => pendingResolve.promise },
    )
    const resolvingFace = resolving.inject()
    resolvingFace.toggleEnabled()
    resolving.dispose()
    pendingResolve.resolve({
      ok: true, value: { groups: [], failures: [] },
    } as never)
    await pendingResolve.promise
  })

  it('ignores writes while read-only and scope notifications after disposal', () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const controller = new SubagentModelSelectionCardController(host.scope, modelCatalogStub().api)
    host.publish({ status: 'ready', writable: false, value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()

    face.toggleEnabled()
    face.toggleModel('alpha\0fast')
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()

    controller.dispose()
    controller.refreshCatalog()
    controller.resetConnection()
    face.toggleEnabled()
    face.retryCatalog()
    face.save()
    host.publish({ value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] } })
    expect(host.mutate).not.toHaveBeenCalled()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot().enabled).toBe(false)
  })
})
