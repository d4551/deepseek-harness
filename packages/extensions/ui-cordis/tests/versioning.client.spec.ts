import { describe, expect, it, vi } from 'vitest'
import type { DynamicCordisLivePackage } from '@deepseek-ai/dsh-cordis-client-runner/client'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  DynamicCordisInventoryRow,
} from '@deepseek-ai/dsh-api-remotes/client'
import { cordisDefineCard, cordisRunCard } from '../src/client/card-model.ts'
import { CordisRunCardRegistry, cordisToolViewKey } from '../src/client/run-card-index.ts'
import { cordisVisibleStatus } from '../src/client/status.ts'

const PLUGIN = 'clock-1' as CordisDynamicPluginId
const PACKAGE = 'pkg-1' as CordisDynamicPackageId
const RUN = 'run-1' as CordisDynamicPluginRunId

const row = (client: boolean): DynamicCordisInventoryRow => ({
  pluginId: PLUGIN,
  agentId: 'session-1' as DynamicCordisInventoryRow['agentId'],
  packages: [{
    packageId: PACKAGE,
    name: 'Clock',
    purpose: 'show time',
    hasHostHalf: true,
    hasClientHalf: client,
  }],
  currentPackageId: PACKAGE,
  activeRun: { packageId: PACKAGE, pluginRunId: RUN },
})

describe('versioned Cordis card models', () => {
  it('reads symmetric Host and Client source fields from cordis_define', () => {
    const card = cordisDefineCard({
      callId: 'call-1',
      name: 'cordis_define',
      argsRaw: JSON.stringify({
        plugin: { kind: 'new', idPrefix: 'clock' },
        name: 'Clock',
        purpose: 'show time',
        code: { host: 'HOST_CODE', client: 'CLIENT_CODE' },
      }),
      turn: 1,
      step: 1,
      time: 1,
      subCalls: [],
    })

    expect(card).toMatchObject({
      pluginId: null,
      packageId: null,
      hostCode: 'HOST_CODE',
      clientCode: 'CLIENT_CODE',
      state: 'running',
    })
  })

  it('reads exact activation metadata from a successful cordis_run result', () => {
    const card = cordisRunCard({
      kind: 'tool-result',
      seq: 9,
      time: 2,
      callId: 'call-2',
      call: { name: 'cordis_run', argsRaw: JSON.stringify({ pluginId: PLUGIN, packageId: PACKAGE, mode: 'run' }) },
      callTime: 1,
      content: [{ type: 'text', text: 'running' }],
      isError: false,
      meta: { pluginId: PLUGIN, packageId: PACKAGE, pluginRunId: RUN },
      subCalls: [],
    })

    expect(card).toMatchObject({
      pluginId: PLUGIN,
      packageId: PACKAGE,
      pluginRunId: RUN,
      mode: 'run',
      seq: 9,
      state: 'ok',
    })
  })

  it('keeps the target identities while cordis_run waits for approval', () => {
    const card = cordisRunCard({
      callId: 'call-3',
      name: 'cordis_run',
      argsRaw: JSON.stringify({ pluginId: PLUGIN, packageId: PACKAGE, mode: 'update' }),
      turn: 1,
      step: 1,
      time: 1,
      subCalls: [],
    })

    expect(card).toMatchObject({
      pluginId: PLUGIN,
      packageId: PACKAGE,
      pluginRunId: null,
      mode: 'update',
      state: 'running',
    })
  })
})

describe('Cordis run-card ownership', () => {
  it('keeps the greatest Session log sequence for one Plugin and Package', () => {
    const store = new CordisRunCardRegistry().forSession('session-1' as DynamicCordisInventoryRow['agentId'])
    const changed = vi.fn()
    store.subscribe(changed)
    const key = cordisToolViewKey(PLUGIN, PACKAGE)

    store.observe({ key, callId: 'new', seq: 20, pluginRunId: RUN })
    store.observe({ key, callId: 'old', seq: 10, pluginRunId: 'run-0' as CordisDynamicPluginRunId })

    expect(store.getSnapshot().get(key)?.callId).toBe('new')
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('serves one snapshot per change and one Store per session', () => {
    const registry = new CordisRunCardRegistry()
    const sessionId = 'session-1' as DynamicCordisInventoryRow['agentId']
    const store = registry.forSession(sessionId)
    expect(registry.forSession(sessionId)).toBe(store)
    expect(registry.forSession('session-2' as DynamicCordisInventoryRow['agentId'])).not.toBe(store)

    const empty = store.getSnapshot()
    expect(empty.size).toBe(0)
    // A read between changes returns the same Map, so React's snapshot
    // comparison sees no change; a change replaces it.
    expect(store.getSnapshot()).toBe(empty)
    const key = cordisToolViewKey(PLUGIN, PACKAGE)
    store.observe({ key, callId: 'first', seq: 1, pluginRunId: RUN })
    const changed = store.getSnapshot()
    expect(changed).not.toBe(empty)
    expect(changed.get(key)?.callId).toBe('first')
    // A superseded observation leaves the snapshot untouched.
    store.observe({ key, callId: 'stale', seq: 0, pluginRunId: RUN })
    expect(store.getSnapshot()).toBe(changed)
  })

  it('stops notifying a listener once it unsubscribes', () => {
    const store = new CordisRunCardRegistry().forSession('session-1' as DynamicCordisInventoryRow['agentId'])
    const listener = vi.fn()
    const off = store.subscribe(listener)
    const key = cordisToolViewKey(PLUGIN, PACKAGE)
    store.observe({ key, callId: 'first', seq: 1, pluginRunId: RUN })
    off()
    store.observe({ key, callId: 'second', seq: 2, pluginRunId: RUN })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().get(key)?.callId).toBe('second')
  })
})

describe('Cordis visible status', () => {
  it('distinguishes Host-only running, Client pending, and fully loaded', () => {
    expect(cordisVisibleStatus(row(false), PACKAGE, [])).toBe('running')
    expect(cordisVisibleStatus(row(true), PACKAGE, [])).toBe('client-pending')
    const loaded: DynamicCordisLivePackage[] = [{
      pluginId: PLUGIN,
      packageId: PACKAGE,
      pluginRunId: RUN,
      name: 'Clock',
      slots: [],
      styleCount: 0,
    }]
    expect(cordisVisibleStatus(row(true), PACKAGE, loaded)).toBe('running')
  })

  it('reads idle for a Plugin with no run and for a Package another run is active on', () => {
    const { activeRun: _active, ...stopped } = row(true)
    expect(cordisVisibleStatus(stopped, PACKAGE, [])).toBe('idle')
    const other = { ...row(true), activeRun: { packageId: 'pkg-2' as CordisDynamicPackageId, pluginRunId: RUN } }
    expect(cordisVisibleStatus(other, PACKAGE, [])).toBe('idle')
    // The active Package is not in the row's package list: the Client half is unknown, so it reads running.
    expect(cordisVisibleStatus(other, 'pkg-2' as CordisDynamicPackageId, [])).toBe('running')
  })
})
