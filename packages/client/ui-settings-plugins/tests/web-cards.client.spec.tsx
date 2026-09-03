// @vitest-environment jsdom

/**
 * The two web Settings cards as a user drives them: the seam's backend
 * selection, one backend's own controls, and what each says when this
 * deployment cannot serve the choice it shows.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { WebAccessCard, type WebAccessCardProps } from '../src/client/WebAccessCard.tsx'
import { WebProviderCard, type WebProviderCardProps } from '../src/client/WebProviderCard.tsx'
import type {
  WebAccessCardState, WebCapabilityState, WebProviderChoice,
} from '../src/client/web-access-card-controller.ts'
import type { WebProviderCardState } from '../src/client/web-provider-card-controller.ts'
import { WEB_PROVIDERS } from '../src/client/web-provider-catalog.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const MINIMUM_ACCESSIBILITY_SCORE = 100

const t = (key: keyof typeof en) => en[key]

const settled: CardShell = {
  available: true,
  writable: true,
  restartRequired: false,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

function choice(id: string, rest: Partial<WebProviderChoice> = {}): WebProviderChoice {
  return {
    id,
    titleKey: 'webFetchHttpTitle',
    descriptionKey: 'webFetchHttpDescription',
    moduleName: `@deepseek-ai/dsh-${id}`,
    mounted: true,
    selected: false,
    ...rest,
  }
}

function capability(selectedId: string, choices: WebProviderChoice[]): WebCapabilityState {
  return {
    field: field(selectedId),
    choices: choices.map(entry => ({ ...entry, selected: entry.id === selectedId })),
    automatic: selectedId === '',
  }
}

/** The catalogued backend for one namespace; every id below is a shipped one. */
function spec(ns: string) {
  const found = WEB_PROVIDERS.find(provider => provider.ns === ns)
  if (found === undefined) throw new Error(`no catalogued backend for ${ns}`)
  return found
}

function renderWebAccess(state: Partial<WebAccessCardState> = {}) {
  const store = createSnapshotStore<WebAccessCardState>({
    ...settled,
    search: capability('deepseek-official', [choice('deepseek-official'), choice('exa')]),
    fetch: capability('playwright', [choice('http'), choice('playwright')]),
    browserMissing: false,
    ...state,
  })
  const actions = cardActions()
  const props = {
    ...actions,
    t,
    useWebAccessCard: bindSnapshotSelector(store),
  } as never as WebAccessCardProps
  render(<main><ul><WebAccessCard {...props} /></ul></main>)
  return { actions, store }
}

function renderWebProvider(ns: string, state: Partial<WebProviderCardState> = {}) {
  const entry = spec(ns)
  const fields: Record<string, CardFieldState> = {}
  for (const declared of entry.fields) fields[declared.field] = field('')
  const store = createSnapshotStore<WebProviderCardState>({
    ...settled,
    fields,
    secretConfigured: false,
    browserConfirmed: true,
    ...state,
  })
  const actions = cardActions()
  const props = {
    ...actions,
    t,
    spec: entry,
    useWebProviderCard: bindSnapshotSelector(store),
  } as never as WebProviderCardProps
  render(<main><ul><WebProviderCard {...props} /></ul></main>)
  return { actions, store }
}

describe('WebAccessCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    renderWebAccess({ available: false })

    expect(screen.queryByText(en.webAccessTitle)).toBeNull()
  })

  it('offers one radio per backend and stages the picked id', () => {
    const { actions } = renderWebAccess()
    fireEvent.click(screen.getByText(en.webAccessTitle))

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(4)
    fireEvent.click(radios[1] as HTMLElement)

    expect(actions.edit).toHaveBeenCalledWith('searchProvider', 'exa')
  })

  it('disables a backend this deployment did not mount and names the package that mounts it', () => {
    renderWebAccess({
      search: capability('deepseek-official', [
        choice('deepseek-official'),
        choice('exa', { mounted: false }),
      ]),
    })
    fireEvent.click(screen.getByText(en.webAccessTitle))

    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios[1]?.disabled).toBe(true)
    expect(screen.getByText(`${en.webProviderNotMounted} @deepseek-ai/dsh-exa`)).toBeTruthy()
  })

  it('explains automatic selection while nothing is pinned', () => {
    renderWebAccess({ search: capability('', [choice('deepseek-official')]) })
    fireEvent.click(screen.getByText(en.webAccessTitle))

    expect(screen.getAllByText(en.webProviderAutomatic).length).toBeGreaterThan(0)
  })

  it('states plainly that no browser was found when the pinned rendering backend has none', () => {
    renderWebAccess({ browserMissing: true })
    fireEvent.click(screen.getByText(en.webAccessTitle))

    expect(screen.getByRole('alert').textContent).toBe(en.webFetchBrowserMissing)
  })

  it('resets a pinned capability back to its composition layer', () => {
    const { actions } = renderWebAccess({
      fetch: {
        field: field('http', { overridden: true }),
        choices: [choice('http', { selected: true }), choice('playwright')],
        automatic: false,
      },
    })
    fireEvent.click(screen.getByText(en.webAccessTitle))

    fireEvent.click(screen.getAllByText(en.reset)[0] as HTMLElement)

    expect(actions.resetField).toHaveBeenCalledWith('fetchProvider')
  })

  it('renders both radio groups with no accessibility violations', async () => {
    renderWebAccess({ browserMissing: true })
    fireEvent.click(screen.getByText(en.webAccessTitle))

    const audit = await auditSurface('WebAccessCard', document.body)
    expect(audit.passed + audit.failed).toBeGreaterThan(0)
    expect(accessibilityFailures([audit], MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})

describe('WebProviderCard', () => {
  it('renders one control per catalogued field and stages its draft', () => {
    const { actions } = renderWebProvider('web-fetch-http')
    fireEvent.click(screen.getByText(en.webFetchHttpTitle))

    fireEvent.change(screen.getByLabelText(en.webFetchTimeoutMs), { target: { value: '2500' } })

    expect(actions.edit).toHaveBeenCalledWith('timeoutMs', '2500')
  })

  it('renders a key as a write-only control reporting whether one is configured', () => {
    renderWebProvider('web-search-exa', { secretConfigured: true })
    fireEvent.click(screen.getByText(en.webSearchExaTitle))

    expect(screen.getByText(en.webApiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.webApiKey).getAttribute('type')).toBe('password')
  })

  it('says a change waits for the next boot when the Host declares restart', () => {
    renderWebProvider('web-search-perplexity', { restartRequired: true })
    fireEvent.click(screen.getByText(en.webSearchPerplexityTitle))

    expect(screen.getByText(en.appliesRestart)).toBeTruthy()
  })

  it('states plainly that no browser was found on the backend that needs one', () => {
    renderWebProvider('web-fetch-playwright', { browserConfirmed: false })
    fireEvent.click(screen.getByText(en.webFetchPlaywrightTitle))

    expect(screen.getByRole('alert').textContent).toBe(en.webFetchBrowserMissing)
  })

  it('says nothing about a browser on a backend that renders no page', () => {
    renderWebProvider('web-fetch-http', { browserConfirmed: false })
    fireEvent.click(screen.getByText(en.webFetchHttpTitle))

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders a blank control for a field the snapshot omits', () => {
    renderWebProvider('web-fetch-http', { fields: {} })
    fireEvent.click(screen.getByText(en.webFetchHttpTitle))

    expect((screen.getByLabelText(en.webFetchUserAgent) as HTMLInputElement).value).toBe('')
  })

  it('resets one field back to its composition layer', () => {
    const { actions } = renderWebProvider('web-fetch-playwright', {
      fields: { executablePath: field('/opt/chrome', { overridden: true }) },
    })
    fireEvent.click(screen.getByText(en.webFetchPlaywrightTitle))

    fireEvent.click(screen.getByText(en.reset))

    expect(actions.resetField).toHaveBeenCalledWith('executablePath')
  })

  it('renders a backend card with no accessibility violations', async () => {
    renderWebProvider('web-fetch-playwright', { browserConfirmed: false, restartRequired: true })
    fireEvent.click(screen.getByText(en.webFetchPlaywrightTitle))

    const audit = await auditSurface('WebProviderCard', document.body)
    expect(audit.passed + audit.failed).toBeGreaterThan(0)
    expect(accessibilityFailures([audit], MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
