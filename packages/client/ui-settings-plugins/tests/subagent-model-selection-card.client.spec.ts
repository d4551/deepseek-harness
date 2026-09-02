/**
 * The subagent model-selection card: how the model directory loads, and how
 * a draft is kept across catalog refreshes and Host revisions.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SubagentModelSelectionSettings } from '@deepseek-ai/dsh-api-remotes/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  SubagentModelSelectionCardController,
} from '../src/client/subagent-model-selection-card-controller.ts'
import { modelCatalogStub } from './model-catalog-stub.client.ts'
import { acceptWrites, deferred } from './scope-stubs.client.ts'

describe('SubagentModelSelectionCardController', () => {
  it('loads directory models and saves the switch and routes atomically', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    acceptWrites(host)
    const models = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: true, revision: 3,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()

    expect(face.hooks.subagentModelSelectionCard.getSnapshot().enabled).toBe(false)
    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 3)
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true,
      dirty: false,
      saving: false,
      failed: false,
    })
  })

  it('starts an empty draft when a ready test scope has no decoded value', () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const controller = new SubagentModelSelectionCardController(host.scope, modelCatalogStub().api)
    host.publish({ status: 'ready', writable: true, revision: 0, value: undefined })
    const face = controller.inject()

    face.toggleEnabled()

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true, dirty: true, invalid: true,
    })
  })

  it('keeps the Host value and reports a rejected write', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()

    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().failed).toBe(true)
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: true,
      dirty: true,
      saving: false,
    })
  })

  it('rejects routes the directory does not carry and toggles follow the draft', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: true, revision: 1,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(state().candidates).toHaveLength(1) })

    face.toggleModel('missing')
    expect(state()).toMatchObject({ dirty: true, invalid: true })
    face.toggleModel('alpha\0fast')
    expect(state()).toMatchObject({ dirty: true, invalid: false })
    expect(state().candidates.find(candidate => candidate.key === 'alpha\0fast')?.selected).toBe(true)
    face.discard()
    expect(state()).toMatchObject({ dirty: false, invalid: false, enabled: false })
    expect(state().candidates.find(candidate => candidate.key === 'alpha\0fast')?.selected).toBe(false)

    face.toggleEnabled()
    expect(state()).toMatchObject({ dirty: true, enabled: true })
    face.toggleEnabled()
    expect(state()).toMatchObject({ dirty: false, enabled: false })
  })

  it('loads stored routes from a partial catalog and ignores toggles for routes it omits', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
      failures: [{ id: 'beta', name: 'Beta', message: 'offline' }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: true, revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] }, user: {},
    })
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('ready') })
    expect(state().catalogPartial).toBe(true)
    expect(state().candidates.find(candidate => candidate.key === 'alpha\0fast')?.selected).toBe(true)

    face.toggleModel('missing')
    expect(state().dirty).toBe(false)
  })

  it('retains selected routes when disabling and loads an already-ready enabled card', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    acceptWrites(host)
    host.publish({
      status: 'ready', writable: true, revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] }, user: {},
    })
    const models = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    const face = controller.inject()
    await vi.waitFor(() => { expect(models.models).toHaveBeenCalledOnce() })

    face.toggleEnabled()
    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: false },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 5)
    })
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      enabled: false, dirty: false,
    })
  })

  it('reports a directory error and retries it', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelCatalogStub({ error: 'offline' })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    host.publish({ status: 'ready', writable: true, value: { enabled: false, allowedModels: [] }, user: {} })
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()

    face.toggleEnabled()
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('error') })
    face.retryCatalog()
    await vi.waitFor(() => { expect(models.models).toHaveBeenCalledTimes(2) })
  })

  it('rejects a draft after the Host revision changes', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => {
      expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1)
    })
    face.toggleModel('alpha\0fast')

    host.publish({
      revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'other', model: 'new' }] },
    })
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: true, failed: false, dirty: true,
    })
    face.save()
    await Promise.resolve()

    expect(host.mutate).not.toHaveBeenCalled()
    face.discard()
    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, failed: false, dirty: false, enabled: true,
    })
  })

  it('settles a draft when a newer Host revision already contains it', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    host.publish({
      revision: 5,
      value: { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] },
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, dirty: false, enabled: true,
    })
  })

  it('retains unsaved routes across a catalog refresh', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    acceptWrites(host)
    host.publish({
      status: 'ready', writable: true, revision: 2,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const refreshed = deferred<never>()
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
          failures: [],
        },
      })
      .mockImplementationOnce(() => refreshed.promise)
    const controller = new SubagentModelSelectionCardController(
      host.scope, { modelCatalog: models },
    )
    const face = controller.inject()
    const state = () => face.hooks.subagentModelSelectionCard.getSnapshot()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(state().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    controller.refreshCatalog()
    expect(state()).toMatchObject({
      catalogStatus: 'loading',
      candidates: [expect.objectContaining({ key: 'alpha\0fast', selected: true })],
    })
    refreshed.resolve({
      ok: true, value: { groups: [], failures: [] },
    } as never)
    await vi.waitFor(() => { expect(state().catalogStatus).toBe('ready') })
    expect(state().candidates).toEqual([
      expect.objectContaining({ key: 'alpha\0fast', available: false, selected: true }),
    ])

    face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['enabled'], value: true },
        { op: 'set', path: ['allowedModels'], value: [{ provider: 'alpha', model: 'fast' }] },
      ], 2)
    })
  })

  it('drops a draft when the connection generation changes', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    const models = modelCatalogStub({
      groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
    })
    host.publish({
      status: 'ready', writable: true, revision: 4,
      value: { enabled: false, allowedModels: [] }, user: {},
    })
    const controller = new SubagentModelSelectionCardController(host.scope, models.api)
    const face = controller.inject()
    face.toggleEnabled()
    await vi.waitFor(() => { expect(face.hooks.subagentModelSelectionCard.getSnapshot().candidates).toHaveLength(1) })
    face.toggleModel('alpha\0fast')

    controller.resetConnection()
    host.publish({
      revision: 4,
      value: { enabled: true, allowedModels: [{ provider: 'other', model: 'new' }] },
    })

    expect(face.hooks.subagentModelSelectionCard.getSnapshot()).toMatchObject({
      conflicted: false, dirty: false, enabled: true,
    })
    face.save()
    await Promise.resolve()
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('reloads the model catalog after invalidation', async () => {
    const host = stubSettingsScope<SubagentModelSelectionSettings>()
    host.publish({
      status: 'ready', writable: true, revision: 1,
      value: { enabled: true, allowedModels: [] }, user: {},
    })
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'alpha', name: 'Alpha', models: [{ id: 'fast', name: 'Fast' }] }],
          failures: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true, value: {
          groups: [{ id: 'beta', name: 'Beta', models: [{ id: 'new', name: 'New' }] }],
          failures: [],
        },
      })
    const controller = new SubagentModelSelectionCardController(
      host.scope, { modelCatalog: models },
    )
    const state = () => controller.inject().hooks.subagentModelSelectionCard.getSnapshot()
    await vi.waitFor(() => { expect(state().candidates[0]?.provider).toBe('alpha') })

    controller.refreshCatalog()

    await vi.waitFor(() => { expect(state().candidates[0]?.provider).toBe('beta') })
    expect(models).toHaveBeenCalledTimes(2)
  })
})
