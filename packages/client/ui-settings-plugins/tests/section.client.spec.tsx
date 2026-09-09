import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { ConfigurablePluginsTab } from '../src/client/ConfigurablePluginsTab.tsx'
import type { ConfigurablePluginsTabProps } from '../src/client/ConfigurablePluginsTab.tsx'
import { PluginsSettingsSection } from '../src/client/PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionProps, PluginsSettingsTabEntry } from '../src/client/PluginsSettingsSection.tsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConfigurablePluginsTabState } from '../src/client/tab-store.ts'
import { en } from '../src/client/locales.ts'
import { settled, t } from './section-support.client.tsx'
import type { SettingsFlowView } from '../src/client/flow-directory.ts'
import { cardProps } from './props.client.ts'

afterEach(cleanup)

const flowViews: readonly SettingsFlowView[] = [
  {
    id: 'web', titleKey: 'webGroupTitle', descriptionKey: 'webFlowDescription', state: settled,
    members: [{ ns: 'web', titleKey: 'webAccessTitle', descriptionKey: 'webAccessDescription' }],
  },
  {
    id: 'agent-review', titleKey: 'approvalGroupTitle', descriptionKey: 'reviewFlowDescription', state: settled,
    members: [{
      ns: 'approval-adversary', titleKey: 'approvalAdversaryTitle', descriptionKey: 'approvalAdversaryDescription',
    }],
  },
]

function renderSection(rows: readonly PluginsSettingsTabEntry[]) {
  const renderSlotStub = ((_key: string, _owner: object, opts?: { only?: string }) => (
    <span>{opts?.only}</span>
  )) as PluginsSettingsSectionProps['renderSlot']
  const props = cardProps<PluginsSettingsSectionProps>({
    t,
    useTabs: <S,>(selector: (value: readonly PluginsSettingsTabEntry[]) => S) => selector(rows),
    renderSlot: renderSlotStub,
  })
  render(<PluginsSettingsSection {...props} />)
}

function renderConfigurable(
  namespaces: string[], cards: Record<string, string> = {}, loaded = true,
  flows: readonly SettingsFlowView[] = [],
) {
  const store = createSnapshotStore<ConfigurablePluginsTabState>({ loaded, namespaces })
  const flowStore = createSnapshotStore(flows)
  const props = cardProps<ConfigurablePluginsTabProps>({
    t,
    useConfigurablePlugins: bindSnapshotSelector(store),
    useSettingsFlows: bindSnapshotSelector(flowStore),
    saveFlow: vi.fn().mockResolvedValue(undefined),
    discardFlow: vi.fn(),
    renderSlot: (_name: string, _owner: object, opts?: { entryKey?: string }) => {
      const card = opts?.entryKey === undefined ? undefined : cards[opts.entryKey]
      return card === undefined ? null : <input aria-label={card} />
    },
  })
  render(<main><ConfigurablePluginsTab {...props} /></main>)
}

describe('PluginsSettingsSection', () => {
  it('says so when no plugin contributed a tab', () => {
    renderSection([])

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('defaults to the first ordered tab and mounts another only after selection', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('configurable')).toBeTruthy()
    expect(screen.queryByText('all')).toBeNull()

    fireEvent.click(all)
    expect(all.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all')).toBeTruthy()
    expect(screen.getByText('configurable').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)

    fireEvent.click(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)
  })

  it('leads with its own heading and intro', () => {
    renderSection([{ id: 'configurable', order: 0, label: en.configurableTab }])

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
  })

  it('moves focus and selection with standard horizontal tab keys', () => {
    renderSection([
      { id: 'configurable', order: 0, label: en.configurableTab },
      { id: 'all', order: 10, label: 'Plugin list' },
      { id: 'diagnostics', order: 20, label: 'Diagnostics' },
    ])

    const configurable = screen.getByRole('tab', { name: en.configurableTab })
    const all = screen.getByRole('tab', { name: 'Plugin list' })
    const diagnostics = screen.getByRole('tab', { name: 'Diagnostics' })
    expect(configurable.getAttribute('tabindex')).toBe('0')
    expect(all.getAttribute('tabindex')).toBe('-1')

    configurable.focus()
    fireEvent.keyDown(configurable, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(all)
    expect(all.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(all, { key: 'End' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(configurable)
    fireEvent.keyDown(configurable, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(diagnostics)
    fireEvent.keyDown(diagnostics, { key: 'Home' })
    expect(document.activeElement).toBe(configurable)

    fireEvent.keyDown(configurable, { key: 'Escape' })
    expect(document.activeElement).toBe(configurable)
    expect(configurable.getAttribute('aria-selected')).toBe('true')
  })
})

describe('ConfigurablePluginsTab', () => {
  it('says so when no plugin contributed a card', () => {
    renderConfigurable([], { bash: 'shell' })

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText('shell')).toBeNull()
  })

  it('withholds the empty line until the Host has answered once', () => {
    // An unanswered read is not the statement that this deployment configures
    // no plugin; saying it anyway would flash a wrong answer on every open.
    renderConfigurable([], { bash: 'shell' }, false)

    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('dispatches one card per namespace, keyed by it', () => {
    renderConfigurable(['bash', 'agent-loop'], { bash: 'shell', 'agent-loop': 'loop' })
    const group = screen.getByRole('button', { name: en.otherGroupTitle })
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(group)
    expect(screen.getAllByRole('textbox').map(item => item.getAttribute('aria-label'))).toEqual(['shell', 'loop'])
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText(en.empty)).toBeNull()
  })

  it('reveals only the selected flow and keeps mounted cards when it closes', () => {
    renderConfigurable(['web', 'approval-adversary'], {
      web: 'search configuration',
      'approval-adversary': 'review configuration',
    }, true, flowViews)

    const search = screen.getByRole('button', { name: `${en.expand}: ${en.webGroupTitle}` })
    const reviews = screen.getByRole('button', { name: `${en.expand}: ${en.approvalGroupTitle}` })
    expect(search.getAttribute('aria-expanded')).toBe('false')
    expect(reviews.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('textbox')).toBeNull()

    expect(search.tagName).toBe('BUTTON')
    fireEvent.click(search)
    const card = screen.getByRole('textbox', { name: 'search configuration' })
    expect(search.getAttribute('aria-expanded')).toBe('true')
    expect(reviews.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(search)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(card.isConnected).toBe(true)
    fireEvent.click(search)
    expect(screen.getByRole('textbox')).toBe(card)

    fireEvent.click(reviews)
    expect(screen.getAllByRole('textbox').map(item => item.getAttribute('aria-label'))).toEqual([
      'search configuration', 'review configuration',
    ])
  })

  it('has no accessibility violations with flows closed or expanded', async () => {
    renderConfigurable(['web', 'approval-adversary'], {
      web: 'search configuration',
      'approval-adversary': 'review configuration',
    }, true, flowViews)
    const closed = await auditSurface('Settings flows closed', document.body)
    for (const control of screen.getAllByRole('button', { name: /^Show settings:/ })) fireEvent.click(control)
    const expanded = await auditSurface('Settings flows expanded', document.body)

    for (const audit of [closed, expanded]) {
      expect(audit.incomplete).toEqual([])
      expect(audit.passed + audit.failed).toBeGreaterThan(0)
    }
    expect(accessibilityFailures([closed, expanded], 100)).toBe('')
  })

  it('presents multiple search editors inside one disclosure with one Save and Discard', () => {
    renderConfigurable(['web', 'provider-one', 'provider-two'], {
      web: 'routing', 'provider-one': 'first provider', 'provider-two': 'second provider',
    }, true, [{
      id: 'web', titleKey: 'webGroupTitle', descriptionKey: 'webFlowDescription', state: settled,
      members: [
        { ns: 'web', titleKey: 'webAccessTitle', descriptionKey: 'webAccessDescription' },
        { ns: 'provider-one', titleKey: 'webSearchExaTitle', descriptionKey: 'webSearchExaDescription' },
        { ns: 'provider-two', titleKey: 'webSearchPerplexityTitle', descriptionKey: 'webSearchPerplexityDescription' },
      ],
    }])

    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.webGroupTitle}` }))

    expect(screen.getAllByRole('textbox')).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: en.discard })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^Hide settings:/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Show settings:/ })).toBeNull()
  })

  it.each([
    { writable: false, invalid: false },
    { writable: true, invalid: true },
  ])('blocks a flow save for its permission or validation state: %j', (state) => {
    renderConfigurable(['approval-adversary'], { 'approval-adversary': 'review fields' }, true, [{
      id: 'agent-review', titleKey: 'approvalGroupTitle', descriptionKey: 'reviewFlowDescription',
      state: { ...settled, ...state, dirty: true, restartRequired: true },
      members: [{
        ns: 'approval-adversary', titleKey: 'approvalAdversaryTitle', descriptionKey: 'approvalAdversaryDescription',
      }],
    }])
    fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.approvalGroupTitle}` }))

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByText(en.appliesRestart)).toBeTruthy()
    if (!state.writable) expect(screen.getByText(en.readOnly)).toBeTruthy()
  })
})
