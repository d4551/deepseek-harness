/**
 * One web backend's controller: the catalogued fields it stages, the secret
 * slot it reports without carrying a value, and the browser its composition
 * layer either names or does not.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import {
  WebProviderCardController,
  type WebProviderSettings,
} from '../src/client/web-provider-card-controller.ts'
import { WEB_PROVIDERS, webProvidersFor } from '../src/client/web-provider-catalog.ts'
import { acceptWrites } from './scope-stubs.client.ts'

/** The catalogued backend for one namespace; every id below is a shipped one. */
function spec(ns: string) {
  const found = WEB_PROVIDERS.find(provider => provider.ns === ns)
  if (found === undefined) throw new Error(`no catalogued backend for ${ns}`)
  return found
}

/** Bind one backend's controller over a Host that accepts writes. */
function boot(ns: string, snapshot: Partial<Parameters<ReturnType<typeof stubSettingsScope<WebProviderSettings>>['publish']>[0]>) {
  const host = stubSettingsScope<WebProviderSettings>()
  acceptWrites(host)
  const controller = new WebProviderCardController(spec(ns), host.scope)
  host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {}, ...snapshot })
  return { host, controller, card: controller.inject() }
}

describe('web provider catalogue', () => {
  it('splits the catalogue by the half of the seam each backend serves', () => {
    expect(webProvidersFor('search').map(provider => provider.providerId))
      .toEqual(['deepseek-official', 'exa', 'perplexity'])
    expect(webProvidersFor('fetch').map(provider => provider.providerId)).toEqual(['http', 'playwright'])
  })
})

describe('WebProviderCardController', () => {
  it('renders every catalogued field of the backend it was given', () => {
    const { card } = boot('web-fetch-http', {
      value: { maxRedirects: 5, userAgent: 'dsh/1.0' },
      base: { maxRedirects: 5, userAgent: 'dsh/1.0' },
    })

    const state = card.hooks.webProviderCard.getSnapshot()
    expect(Object.keys(state.fields)).toEqual([
      'maxResponseBytes', 'maxBodyChars', 'timeoutMs', 'maxRedirects', 'userAgent',
    ])
    expect(state.fields.maxRedirects?.text).toBe('5')
    expect(state.fields.userAgent?.text).toBe('dsh/1.0')
    expect(card.spec.ns).toBe('web-fetch-http')
    expect(controllerNamespace('web-fetch-http')).toBe('web-fetch-http')
  })

  it('says a change waits for the next boot when the Host declares restart', () => {
    const { card } = boot('web-fetch-http', { applies: 'restart' })

    expect(card.hooks.webProviderCard.getSnapshot().restartRequired).toBe(true)
  })

  it('stages a numeric draft and writes it on save', async () => {
    const { card, host } = boot('web-fetch-http', {})

    card.edit('timeoutMs', '2500')
    card.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledOnce() })

    expect(host.set).toHaveBeenCalledWith('timeoutMs', 2500)
  })

  it('reports a configured key from the namespace secret slots, never from a value', () => {
    const { card } = boot('web-search-exa', { secrets: [{ path: ['apiKey'], set: true }] })

    expect(card.hooks.webProviderCard.getSnapshot().secretConfigured).toBe(true)
    expect(card.hooks.webProviderCard.getSnapshot().fields.apiKey?.text).toBe('')
  })

  it('reports an unconfigured key while the Host declares the slot empty', () => {
    const { card } = boot('web-search-perplexity', { secrets: [{ path: ['apiKey'], set: false }] })

    expect(card.hooks.webProviderCard.getSnapshot().secretConfigured).toBe(false)
  })

  it('reports no secret for a backend whose catalogue entry declares none', () => {
    const { card } = boot('web-fetch-playwright', { secrets: [{ path: ['apiKey'], set: true }] })

    expect(card.hooks.webProviderCard.getSnapshot().secretConfigured).toBe(false)
  })

  it('confirms the browser the composition layer names', () => {
    const { card } = boot('web-fetch-playwright', { base: { executablePath: '/opt/chromium' } })

    expect(card.hooks.webProviderCard.getSnapshot().browserConfirmed).toBe(true)
  })

  it('confirms no browser when the composition layer names none, or none at all', () => {
    expect(boot('web-fetch-playwright', { base: { maxBodyChars: 10 } })
      .card.hooks.webProviderCard.getSnapshot().browserConfirmed).toBe(false)
    expect(boot('web-fetch-playwright', { base: undefined })
      .card.hooks.webProviderCard.getSnapshot().browserConfirmed).toBe(false)
    expect(boot('web-fetch-playwright', { base: { executablePath: '' } })
      .card.hooks.webProviderCard.getSnapshot().browserConfirmed).toBe(false)
  })

  it('confirms no browser for a backend whose catalogue entry declares no browser field', () => {
    const { card } = boot('web-fetch-http', { base: { executablePath: '/opt/chromium' } })

    expect(card.hooks.webProviderCard.getSnapshot().browserConfirmed).toBe(false)
  })
})

/** The namespace a controller reports for one catalogued backend. */
function controllerNamespace(ns: string): string {
  const host = stubSettingsScope<WebProviderSettings>()
  return new WebProviderCardController(spec(ns), host.scope).namespace
}
