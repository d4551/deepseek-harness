/**
 * The configurable-plugins tab: which served namespaces the registered cards
 * claim, and what the tab still reports after a failed refresh or disposal.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  SettingsDescribeMirror, type SettingsMirrorSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ConfigurablePluginsTabController } from '../src/client/tab-store.ts'

describe('ConfigurablePluginsTabController', () => {
  function settingsApi(namespaces: string[]) {
    const describe = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: {
        writable: true,
        hasDocument: true,
        namespaces: namespaces.map(ns => ({
          ns, schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 0,
        })),
      },
    }))
    return { mirror: new SettingsDescribeMirror({ settings: { describe } } as never), describe }
  }

  /** Slot ledger stand-in: one stored entry per registered card key. */
  function ledger(...keys: string[]) {
    return keys.map(key => ({ component: null, options: { key } }))
  }

  it('dispatches the served namespaces a card claims, in card registration order', async () => {
    const settings = settingsApi(['bash', 'ui-theme', 'agent-loop'])
    const controller = new ConfigurablePluginsTabController(settings.mirror, () => ledger('agent-loop', 'bash'))

    await settings.mirror.ensure()

    // ui-theme is served but claimed by no card here — another surface owns
    // it. The order is the cards', not the Host's: plugin activation can
    // reorder the description between boots.
    expect(controller.inject().hooks.configurablePlugins.getSnapshot().namespaces)
      .toEqual(['agent-loop', 'bash'])
  })

  it('never dispatches a card whose namespace this deployment does not serve', async () => {
    const settings = settingsApi(['bash'])
    const controller = new ConfigurablePluginsTabController(settings.mirror, () => ledger('bash', 'web-search-deepseek'))

    await settings.mirror.ensure()

    expect(controller.inject().hooks.configurablePlugins.getSnapshot().namespaces).toEqual(['bash'])
  })

  it('takes a card registered after the read without asking the Host again', async () => {
    const settings = settingsApi(['bash'])
    let entries = ledger()
    const controller = new ConfigurablePluginsTabController(settings.mirror, () => entries)
    await settings.mirror.ensure()
    expect(controller.inject().hooks.configurablePlugins.getSnapshot().namespaces).toEqual([])

    entries = ledger('bash')
    controller.refresh()

    expect(controller.inject().hooks.configurablePlugins.getSnapshot().namespaces).toEqual(['bash'])
    expect(settings.describe).toHaveBeenCalledOnce()
  })

  it('keeps the namespaces it knew when a refresh fails', async () => {
    const settings = settingsApi(['bash'])
    const controller = new ConfigurablePluginsTabController(settings.mirror, () => ledger('bash'))
    await settings.mirror.ensure()
    settings.describe.mockRejectedValueOnce(new Error('offline'))

    await settings.mirror.load()

    expect(controller.inject().hooks.configurablePlugins.getSnapshot().namespaces).toEqual(['bash'])
  })

  it('stops following the mirror once disposed, and never claims it was answered', async () => {
    const settings = settingsApi(['bash'])
    const controller = new ConfigurablePluginsTabController(settings.mirror, () => ledger('bash'))

    controller.dispose()
    await settings.mirror.load()

    expect(controller.inject().hooks.configurablePlugins.getSnapshot())
      .toEqual({ loaded: false, namespaces: [] })
  })

  it('ignores a slot-ledger change that arrives after disposal', async () => {
    const settings = settingsApi(['bash'])
    let entries = ledger()
    const controller = new ConfigurablePluginsTabController(settings.mirror, () => entries)
    await settings.mirror.ensure()

    controller.dispose()
    entries = ledger('bash')
    controller.refresh()

    expect(controller.inject().hooks.configurablePlugins.getSnapshot().namespaces).toEqual([])
  })

  it('ignores a mirror notification already queued when disposal starts', () => {
    const listeners = new Set<() => void>()
    let snapshot: SettingsMirrorSnapshot = {
      status: 'ready' as const,
      view: { writable: true, hasDocument: true, namespaces: [] },
      error: null,
    }
    const describeFace = {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      ensure: () => Promise.resolve(),
      acceptView: vi.fn(),
    } as never
    const notify = (): void => {
      for (const listener of listeners) listener()
    }
    const controller = new ConfigurablePluginsTabController(describeFace, () => ledger('bash'))
    expect(controller.inject().hooks.configurablePlugins.getSnapshot())
      .toEqual({ loaded: true, namespaces: [] })

    controller.dispose()
    snapshot = {
      status: 'ready',
      view: {
        writable: true,
        hasDocument: true,
        namespaces: [{
          ns: 'bash', schema: {}, value: {}, applies: 'live', secrets: [], revision: 1,
        }],
      },
      error: null,
    }
    notify()

    expect(controller.inject().hooks.configurablePlugins.getSnapshot())
      .toEqual({ loaded: true, namespaces: [] })
  })

  it('reports the Host answered even when it serves nothing this tab shows', async () => {
    const settings = settingsApi(['ui-theme'])
    const controller = new ConfigurablePluginsTabController(settings.mirror, () => ledger('bash'))

    await settings.mirror.ensure()

    expect(controller.inject().hooks.configurablePlugins.getSnapshot())
      .toEqual({ loaded: true, namespaces: [] })
  })
})
