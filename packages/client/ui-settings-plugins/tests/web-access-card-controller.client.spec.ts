/**
 * The web-access controller: what it offers for each half of the seam, what it
 * says about a backend this deployment did not mount, and when it reports that
 * the selected rendering backend has no browser behind it.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { WebAccessCardController, type WebAccessSettings } from '../src/client/web-access-card-controller.ts'
import { acceptWrites, setOp } from './scope-stubs.client.ts'

/** One served namespace as the mirror reports it. */
function view(ns: string, base?: Record<string, JsonValue>): SettingsNamespaceView {
  return {
    ns,
    schema: {},
    value: {},
    applies: 'live',
    secrets: [],
    revision: 0,
    ...base === undefined ? {} : { base },
  }
}

/** A describe face serving a fixed namespace set, with a hand-driven republish. */
function describeFace(namespaces: SettingsNamespaceView[]): SettingsDescribeFace & { publish: (next: SettingsNamespaceView[]) => void } {
  let served = namespaces
  const listeners = new Set<() => void>()
  const snapshot = (): SettingsMirrorSnapshot => ({
    status: 'ready',
    view: { namespaces: served, writable: true, hasDocument: true },
    error: null,
  })
  return {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ensure: () => Promise.resolve(),
    acceptView: () => {},
    publish: (next) => {
      served = next
      for (const listener of listeners) listener()
    },
  }
}

/** The seam's shipped pins over a deployment that mounts everything. */
function boot(served: SettingsNamespaceView[], section: WebAccessSettings = {
  searchProvider: 'deepseek-official',
  fetchProvider: 'playwright',
}) {
  const host = stubSettingsScope<WebAccessSettings>()
  acceptWrites(host)
  const face = describeFace(served)
  const controller = new WebAccessCardController(host.scope, face)
  host.publish({ status: 'ready', writable: true, value: section, base: section, user: {} })
  return { host, face, controller, card: controller.inject() }
}

/** Every namespace the shipped bundle serves, with a confirmed browser. */
const ALL_MOUNTED = [
  view('web-search-deepseek'),
  view('web-search-exa'),
  view('web-search-perplexity'),
  view('web-fetch-http'),
  view('web-fetch-playwright', { executablePath: '/opt/chromium' }),
]

describe('WebAccessCardController', () => {
  it('offers every mounted backend for each half of the seam and marks the pinned one', () => {
    const { card } = boot(ALL_MOUNTED)

    const state = card.hooks.webAccessCard.getSnapshot()
    expect(state.search.choices.map(choice => choice.id))
      .toEqual(['deepseek-official', 'exa', 'perplexity'])
    expect(state.fetch.choices.map(choice => choice.id)).toEqual(['http', 'playwright'])
    expect(state.search.choices.find(choice => choice.selected)?.id).toBe('deepseek-official')
    expect(state.fetch.choices.find(choice => choice.selected)?.id).toBe('playwright')
    expect(state.search.automatic).toBe(false)
    expect(state.browserMissing).toBe(false)
  })

  it('lists a backend this deployment did not mount last, naming the package that mounts it', () => {
    const { card } = boot([view('web-search-deepseek'), view('web-fetch-http'), view('web-fetch-playwright', {
      executablePath: '/opt/chromium',
    })])

    const search = card.hooks.webAccessCard.getSnapshot().search
    expect(search.choices.map(choice => ({ id: choice.id, mounted: choice.mounted }))).toEqual([
      { id: 'deepseek-official', mounted: true },
      { id: 'exa', mounted: false },
      { id: 'perplexity', mounted: false },
    ])
    expect(search.choices[1]?.moduleName).toBe('@deepseek-ai/dsh-web-search-exa')
  })

  it('reports an unpinned capability as automatic', () => {
    const { card } = boot(ALL_MOUNTED, {})

    expect(card.hooks.webAccessCard.getSnapshot().search.automatic).toBe(true)
    expect(card.hooks.webAccessCard.getSnapshot().fetch.automatic).toBe(true)
  })

  it('republishes when the served set moves', () => {
    const { card, face } = boot(ALL_MOUNTED)
    expect(card.hooks.webAccessCard.getSnapshot().search.choices[0]?.mounted).toBe(true)

    face.publish([view('web-fetch-playwright', { executablePath: '/opt/chromium' })])

    expect(card.hooks.webAccessCard.getSnapshot().search.choices.every(choice => !choice.mounted)).toBe(true)
  })

  it('stages a pin and writes it on save', async () => {
    const { card, host } = boot(ALL_MOUNTED)

    card.edit('searchProvider', 'exa')
    expect(card.hooks.webAccessCard.getSnapshot().search.choices.find(choice => choice.selected)?.id).toBe('exa')
    card.save()
    await vi.waitFor(() => { expect(host.mutate).toHaveBeenCalledOnce() })

    expect(host.mutate).toHaveBeenCalledWith([setOp('searchProvider', 'exa')])
  })

  it('reports a missing browser only while the rendering backend is the pinned one', () => {
    const withoutBrowser = [
      view('web-search-deepseek'),
      view('web-fetch-http'),
      view('web-fetch-playwright', { maxBodyChars: 1_000 }),
    ]
    const { card } = boot(withoutBrowser)
    expect(card.hooks.webAccessCard.getSnapshot().browserMissing).toBe(true)

    card.edit('fetchProvider', 'http')

    expect(card.hooks.webAccessCard.getSnapshot().browserMissing).toBe(false)
  })

  it('reports a missing browser when the rendering section publishes no composition layer at all', () => {
    const { card } = boot([view('web-fetch-playwright')])

    expect(card.hooks.webAccessCard.getSnapshot().browserMissing).toBe(true)
  })

  it('reports no missing browser while the rendering backend is not mounted', () => {
    const { card } = boot([view('web-search-deepseek'), view('web-fetch-http')])

    expect(card.hooks.webAccessCard.getSnapshot().browserMissing).toBe(false)
  })

  it('stops publishing once disposed', () => {
    const { card, face, controller } = boot(ALL_MOUNTED)
    const before = card.hooks.webAccessCard.getSnapshot()

    controller.dispose()
    face.publish([])

    expect(card.hooks.webAccessCard.getSnapshot()).toBe(before)
  })
})
