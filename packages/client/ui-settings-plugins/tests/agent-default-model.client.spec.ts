/**
 * The staged default-model card: the route join against the live catalog, the
 * revision-fenced save, conflicts from Host-side edits, and catalog failures.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  AgentDefaultModelSettings, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { AgentDefaultModelCardController } from '../src/client/agent-default-model-card-controller.ts'
import { modelCatalogStub } from './model-catalog-stub.client.ts'
import { deferred } from './scope-stubs.client.ts'

type StubHost = ReturnType<typeof stubSettingsScope<AgentDefaultModelSettings>>
type CardFace = ReturnType<AgentDefaultModelCardController['inject']>

/** Mount a card whose scope document is ready and whose catalog has answered. */
async function readyFace(
  host: StubHost,
  models: ReturnType<typeof modelCatalogStub>,
  value: AgentDefaultModelSettings,
  options: { revision?: number; writable?: boolean } = {},
): Promise<CardFace> {
  const controller = new AgentDefaultModelCardController(host.scope, models.api)
  host.publish({
    status: 'ready',
    writable: options.writable ?? true,
    ...(options.revision === undefined ? {} : { revision: options.revision }),
    value,
    user: {},
  })
  const face = controller.inject()
  await vi.waitFor(() => {
    expect(face.hooks.agentDefaultModelCard.getSnapshot().catalogStatus).toBe('ready')
  })
  return face
}

/**
 * Make the stub behave like a Host that applies every mutation op the card
 * sends: `set` writes one string field, anything else clears it.
 */
function acceptWrites(host: StubHost): void {
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const stored = host.scope.getSnapshot().value
    const fields = new Map<string, string>()
    if (stored !== undefined) {
      fields.set('provider', stored.provider)
      fields.set('model', stored.model)
      if (stored.reasoningEffort !== undefined) fields.set('reasoningEffort', stored.reasoningEffort)
    }
    for (const op of ops) {
      const field = op.path[0]
      if (typeof field !== 'string') continue
      if (op.op === 'set' && typeof op.value === 'string') fields.set(field, op.value)
      if (op.op === 'unset') fields.delete(field)
    }
    const provider = fields.get('provider')
    const model = fields.get('model')
    if (provider === undefined || model === undefined) {
      throw new Error('the card always writes both route fields')
    }
    const effort = fields.get('reasoningEffort')
    host.publish({
      value: effort === undefined ? { provider, model } : { provider, model, reasoningEffort: effort },
      user: Object.fromEntries(fields),
    })
  })
}

describe('AgentDefaultModelCardController', () => {
  const groups = [{ id: 'alpha', name: 'Alpha API', models: [{ id: 'fast', name: 'Fast' }] }]

  it('injects one snapshot store named for the hook the card renders through', () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const controller = new AgentDefaultModelCardController(host.scope, modelCatalogStub({ groups }).api)
    host.publish({
      status: 'ready', writable: true,
      value: { provider: 'alpha', model: 'fast' }, user: {},
    })

    expect(Object.keys(controller.inject().hooks)).toEqual(['agentDefaultModelCard'])
  })

  it('loads directory models, stages a route, and saves provider, model, and the cleared effort atomically', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    acceptWrites(host)
    const models = modelCatalogStub({ groups })
    const controller = new AgentDefaultModelCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: true, revision: 3,
      value: { provider: 'alpha', model: 'slow' }, user: {},
    })
    const face = controller.inject()

    await vi.waitFor(() => {
      expect(face.hooks.agentDefaultModelCard.getSnapshot().candidates).toHaveLength(1)
    })
    expect(face.selectModel('missing')).toBe(false)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(false)
    expect(face.selectModel('alpha\0fast')).toBe(true)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(true)
    const pendingSave = face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalledWith([
        { op: 'set', path: ['provider'], value: 'alpha' },
        { op: 'set', path: ['model'], value: 'fast' },
        { op: 'unset', path: ['reasoningEffort'] },
      ], 3)
    })
    await expect(pendingSave).resolves.toBe(true)

    expect(face.hooks.agentDefaultModelCard.getSnapshot()).toMatchObject({
      dirty: false,
      saving: false,
      failed: false,
    })
  })

  it('reports a rejected write and keeps the draft staged', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const models = modelCatalogStub({ groups })
    const face = await readyFace(host, models, { provider: 'alpha', model: 'slow' })

    face.selectModel('alpha\0fast')
    const pendingSave = face.save()
    await vi.waitFor(() => {
      expect(face.hooks.agentDefaultModelCard.getSnapshot().failed).toBe(true)
    })
    await expect(pendingSave).resolves.toBe(false)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(true)
  })

  it('flags a draft the Host displaced, and clears it once the values agree again', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const models = modelCatalogStub({ groups })
    const face = await readyFace(host, models, { provider: 'alpha', model: 'slow' }, { revision: 5 })

    face.selectModel('alpha\0fast')
    host.publish({
      status: 'ready', writable: true, revision: 6,
      value: { provider: 'beta', model: 'other' }, user: {},
    })
    expect(face.hooks.agentDefaultModelCard.getSnapshot().conflicted).toBe(true)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(true)

    host.publish({
      status: 'ready', writable: true, revision: 7,
      value: { provider: 'alpha', model: 'fast' }, user: {},
    })
    expect(face.hooks.agentDefaultModelCard.getSnapshot().conflicted).toBe(false)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(false)
  })

  it('refuses a save fenced to a revision the Host has already moved past', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    acceptWrites(host)
    const models = modelCatalogStub({ groups })
    const face = await readyFace(host, models, { provider: 'alpha', model: 'slow' }, { revision: 5 })

    face.selectModel('alpha\0fast')
    host.publish({
      status: 'ready', writable: true, revision: 6,
      value: { provider: 'beta', model: 'other' }, user: {},
    })

    await expect(face.save()).resolves.toBe(false)
    expect(host.mutate).not.toHaveBeenCalled()
    expect(face.hooks.agentDefaultModelCard.getSnapshot().conflicted).toBe(true)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(true)
  })

  it('fences a draft to the revision its first staging saw, not its last', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    acceptWrites(host)
    const models = modelCatalogStub({
      groups: [{
        id: 'alpha',
        name: 'Alpha API',
        models: [{ id: 'fast', name: 'Fast' }, { id: 'deep', name: 'Deep' }],
      }],
    })
    const face = await readyFace(host, models, { provider: 'alpha', model: 'slow' }, { revision: 4 })

    expect(face.selectModel('alpha\0fast')).toBe(true)
    expect(face.selectModel('alpha\0deep')).toBe(true)
    await expect(face.save()).resolves.toBe(true)

    expect(host.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['provider'], value: 'alpha' },
      { op: 'set', path: ['model'], value: 'deep' },
      { op: 'unset', path: ['reasoningEffort'] },
    ], 4)
  })

  it('discards a staged route', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const models = modelCatalogStub({ groups })
    const face = await readyFace(host, models, { provider: 'alpha', model: 'slow' })

    face.selectModel('alpha\0fast')
    expect(face.discard()).toBe(true)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(false)
  })

  it('surfaces catalog errors, retries, and reloads on invalidation', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const models = modelCatalogStub({ error: 'offline' })
    const controller = new AgentDefaultModelCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: true,
      value: { provider: 'alpha', model: 'slow' }, user: {},
    })
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.agentDefaultModelCard.getSnapshot().catalogStatus).toBe('error')
    })

    controller.refreshCatalog()
    await vi.waitFor(() => {
      expect(models.models).toHaveBeenCalledTimes(2)
    })
    controller.resetConnection()
    host.publish({
      status: 'ready', writable: true,
      value: { provider: 'alpha', model: 'slow' }, user: {},
    })
    await vi.waitFor(() => {
      expect(models.models).toHaveBeenCalledTimes(3)
    })
  })

  it('marks a partial catalog and an empty directory', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const models = modelCatalogStub({
      groups,
      failures: [{ id: 'beta', name: 'Beta', message: 'offline' }],
    })
    const controller = new AgentDefaultModelCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: true,
      value: { provider: 'alpha', model: 'slow' }, user: {},
    })
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.agentDefaultModelCard.getSnapshot().catalogPartial).toBe(true)
    })

    controller.dispose()
    const retried = face.retryCatalog()
    await expect(retried).resolves.toBe(false)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().catalogStatus).not.toBe('loading')
  })

  it('treats a ready scope with no decoded value as having no stored route', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    acceptWrites(host)
    const models = modelCatalogStub({ groups })
    const controller = new AgentDefaultModelCardController(host.scope, models.api)
    host.publish({ status: 'ready', writable: true, revision: 0, value: undefined })
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.agentDefaultModelCard.getSnapshot().catalogStatus).toBe('ready')
    })

    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(false)
    face.selectModel('alpha\0fast')
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(true)
    const pendingSave = face.save()
    await vi.waitFor(() => {
      expect(host.mutate).toHaveBeenCalled()
    })
    await expect(pendingSave).resolves.toBe(true)
  })

  it('ignores staging, saving, and reloading once disposed or read-only', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const models = modelCatalogStub({ groups })
    const controller = new AgentDefaultModelCardController(host.scope, models.api)
    host.publish({
      status: 'ready', writable: false,
      value: { provider: 'alpha', model: 'slow' }, user: {},
    })
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.agentDefaultModelCard.getSnapshot().catalogStatus).toBe('ready')
    })

    expect(face.selectModel('alpha\0fast')).toBe(false)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(false)
    await expect(face.save()).resolves.toBe(false)

    host.publish({ status: 'ready', writable: true, value: undefined })
    expect(face.hooks.agentDefaultModelCard.getSnapshot().dirty).toBe(false)
    await expect(face.save()).resolves.toBe(false)

    controller.dispose()
    const calls = models.models.mock.calls.length
    controller.refreshCatalog()
    controller.resetConnection()
    expect(models.models.mock.calls.length).toBe(calls)
  })

  it('skips a save that would rewrite the stored route and one for no value', async () => {
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const models = modelCatalogStub({ groups })
    const face = await readyFace(host, models, { provider: 'alpha', model: 'slow' })

    await expect(face.save()).resolves.toBe(false)
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('blocks edits while a save is in flight and lets the Host land over it', async () => {
    const gate = deferred<undefined>()
    const host = stubSettingsScope<AgentDefaultModelSettings>()
    const mutate = vi.fn(() => gate.promise)
    const models = modelCatalogStub({ groups })
    const controller = new AgentDefaultModelCardController({ ...host.scope, mutate }, models.api)
    host.publish({
      status: 'ready', writable: true, revision: 2,
      value: { provider: 'alpha', model: 'slow' }, user: {},
    })
    const face = controller.inject()
    await vi.waitFor(() => {
      expect(face.hooks.agentDefaultModelCard.getSnapshot().catalogStatus).toBe('ready')
    })

    face.selectModel('alpha\0fast')
    const pendingSave = face.save()
    await vi.waitFor(() => {
      expect(face.hooks.agentDefaultModelCard.getSnapshot().saving).toBe(true)
    })
    expect(face.selectModel('alpha\0fast')).toBe(false)
    expect(face.discard()).toBe(false)
    host.publish({
      status: 'ready', writable: true, revision: 3,
      value: { provider: 'beta', model: 'other' }, user: {},
    })
    expect(face.hooks.agentDefaultModelCard.getSnapshot().conflicted).toBe(false)

    controller.dispose()
    gate.resolve(undefined)
    expect(face.hooks.agentDefaultModelCard.getSnapshot().saving).toBe(true)
    await expect(pendingSave).resolves.toBe(false)
  })
})
