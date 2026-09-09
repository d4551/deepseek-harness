import { cleanup, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'
import * as primitives from '../src/index.ts'
import * as icons from '../src/icons/index.tsx'
import {
  diffBlockLabels,
  jsonTreeLabels,
  markdownLabels,
  readBlockLabels,
  searchBlockLabels,
  terminalBlockLabels,
  webBlockLabels,
} from './labels.client.ts'

/**
 * Aggregate floor for the primitives lane, equal to its recorded score: every
 * decided check passes today, so any failed check fails the run. A floor set
 * below the record would let that many regressions land while still reading as
 * a floor.
 */
const MINIMUM_ACCESSIBILITY_SCORE = 100

const {
  BrandWordmark, Button, CatLogo, CodeBlock, ConnectionBanner, DiffBlock, DisclosureRow, FishLogo, FlowRow,
  GlyphButton, HoverCard, Input, InspectPill, JsonBlock, JsonTree, MarkdownText, Menu, MessageText, Modal,
  OnboardingSurface, Pill, ReadBlock, ReferenceIcon, ResultText, RiskConfirmation, RowSeparator, RowSummary,
  SearchBlock, Select, SettingsActions, SettingsDisclosure, SettingsFields, StateDot, TerminalBlock, Textarea, Toast, Tooltip, WebBlock,
} = primitives

function SettingsDisclosureSurface() {
  const [open, setOpen] = useState(true)
  return (
    <SettingsDisclosure title="Search" toggleLabel="Search settings" open={open} busy={false} status={null}
      onToggle={() => {
        setOpen(!open)
        return !open
      }}>
      <p>Search provider configuration</p>
    </SettingsDisclosure>
  )
}

function SettingsActionsSurface() {
  const [draft, setDraft] = useState('Search')
  const [saved, setSaved] = useState('')
  return (
    <>
      <Input aria-label="Settings name" value={draft} onChange={(event) => { setDraft(event.target.value) }} />
      <SettingsActions saveLabel="Save" discardLabel="Discard" saveDisabled={draft === saved} discardDisabled={draft === saved}
        onSave={() => { setSaved(draft) }} onDiscard={() => { setDraft(saved) }} />
    </>
  )
}

/**
 * One render per exported component. Every entry opens the component in the
 * state a user actually sees, because a closed dialog or a hidden popup renders
 * nothing for axe to inspect.
 */
const SURFACES: Readonly<Record<string, () => ReactElement>> = {
  BrandWordmark: () => <BrandWordmark size={24} />,
  Button: () => <Button variant="primary">Send</Button>,
  CodeBlock: () => <CodeBlock code="const answer = 42\n" lang="ts" copyLabel="Copy" copiedLabel="Copied" />,
  ConnectionBanner: () => <ConnectionBanner reconnecting label="Reconnecting to the session" />,
  DiffBlock: () => (
    <DiffBlock
      diffs={[{ path: 'src/index.ts', oldText: 'const a = 0\n', newText: 'const a = 1\n' }]}
      labels={diffBlockLabels}
    />
  ),
  DisclosureRow: () => (
    <DisclosureRow icon={<StateDot state="done" />} title="Tool call" open expandable onToggle={() => {}}>
      <p>Result body</p>
    </DisclosureRow>
  ),
  CatLogo: () => <CatLogo size={24} />,
  FishLogo: () => <FishLogo size={24} />,
  // The flow-row parts are audited in the row they compose, because a bare
  // separator or summary decides nothing on its own.
  FlowRow: () => (
    <FlowRow>
      <span>Bash</span>
      <RowSeparator />
      <RowSummary>ls -la</RowSummary>
    </FlowRow>
  ),
  GlyphButton: () => <GlyphButton surface="bar" aria-label="Pause goal"><StateDot state="ongoing" /></GlyphButton>,
  InspectPill: () => <InspectPill label="Inspect" onClick={() => {}} />,
  HoverCard: () => (
    <HoverCard anchor={<button type="button">Details</button>} content={<p>More</p>} copyLabel="Copy" copiedLabel="Copied" />
  ),
  Input: () => <Input aria-label="Search sessions" placeholder="Search" />,
  JsonBlock: () => (
    <JsonBlock label="Request" payload={{ model: 'deepseek-chat' }} defaultOpen truncatedLabel={total => `${total} chars`} />
  ),
  JsonTree: () => <JsonTree data={{ ok: true, items: [1, 2] }} label="Result" labels={jsonTreeLabels} />,
  MarkdownText: () => <MarkdownText text={'# Title\n\nBody with a [link](https://example.com).'} labels={markdownLabels} />,
  Menu: () => (
    <Menu
      open
      anchor={<button type="button">Open menu</button>}
      items={[{ id: 'one', label: 'First' }]}
      onSelect={() => {}}
      onClose={() => {}}
    />
  ),
  MessageText: () => <MessageText text="Plain user message" />,
  Modal: () => (
    <Modal open onClose={() => {}} title="Create session" closeLabel="Close" description="Pick a workspace">
      <p>Body</p>
    </Modal>
  ),
  OnboardingSurface: () => <OnboardingSurface label="Set up DeepSeek Harness"><h1>Welcome</h1></OnboardingSurface>,
  Pill: () => <Pill active onClick={() => {}}>Filter</Pill>,
  ReadBlock: () => (
    <ReadBlock
      label="src/index.ts"
      lines={[{ number: 1, text: 'export const a = 1' }]}
      totalLines={1}
      labels={readBlockLabels}
    />
  ),
  ReferenceIcon: () => <ReferenceIcon kind="file" />,
  ResultText: () => <ResultText error>Command failed: exit 1</ResultText>,
  RowSeparator: () => (
    <FlowRow>
      <span>Think</span>
      <RowSeparator />
      <span>12 seconds</span>
    </FlowRow>
  ),
  RowSummary: () => (
    <FlowRow>
      <span>Read</span>
      <RowSummary>src/index.ts</RowSummary>
    </FlowRow>
  ),
  RiskConfirmation: () => (
    <RiskConfirmation
      open
      title="Delete session"
      description="This cannot be undone."
      acknowledgeLabel="I understand"
      cancelLabel="Cancel"
      closeLabel="Close"
      confirmLabel="Delete"
      acknowledged={false}
      onAcknowledgedChange={() => {}}
      onCancel={() => {}}
      onConfirm={() => {}}
    />
  ),
  SearchBlock: () => (
    <SearchBlock kind="paths" paths={['src/index.ts', 'src/plugin.ts']} total={2} truncated={false} labels={searchBlockLabels} />
  ),
  Select: () => <Select aria-label="Task owner"><option value="lead">Lead</option></Select>,
  SettingsActions: () => <SettingsActionsSurface />,
  SettingsDisclosure: () => <SettingsDisclosureSurface />,
  SettingsFields: () => <SettingsFields title="Provider" description="Search provider settings"><Input aria-label="Provider name" /></SettingsFields>,
  StateDot: () => <StateDot state="ongoing" />,
  TerminalBlock: () => (
    <TerminalBlock command="ls -la" cwd="/repo" output="total 0" exitCode={0} labels={terminalBlockLabels} />
  ),
  Textarea: () => <Textarea aria-label="Task description" defaultValue="Review the settings flow" />,
  Toast: () => <Toast text="Copied" onDone={() => {}} />,
  Tooltip: () => <Tooltip label="Run"><button type="button">Run</button></Tooltip>,
  WebBlock: () => (
    <WebBlock
      kind="search"
      sources={[{ url: 'https://example.com', title: 'Example', snippet: 'An example source' }]}
      truncated={false}
      labels={webBlockLabels}
    />
  ),
}

/** A React memo wrapper is a component too, and must not escape the audit. */
const MEMO_TAG = Symbol.for('react.memo')

/**
 * Every exported icon, rendered at its default size. Icons take one uniform
 * prop set, so deriving the list keeps a newly exported icon audited instead of
 * waiting for someone to add a table entry.
 */
function iconSurfaces(): Record<string, () => ReactElement> {
  const surfaces: Record<string, () => ReactElement> = {}
  for (const [name, Icon] of Object.entries(icons)) {
    surfaces[name] = () => <Icon />
  }
  return surfaces
}

const AUDITED: Readonly<Record<string, () => ReactElement>> = { ...SURFACES, ...iconSurfaces() }

function isComponent(value: unknown): boolean {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null
    && '$$typeof' in value && value.$$typeof === MEMO_TAG
}

function exportedComponentNames(): string[] {
  return Object.entries(primitives)
    .filter(([name, value]) => /^[A-Z]/.test(name) && isComponent(value))
    .map(([name]) => name)
    .sort()
}

describe('ui-primitives accessibility', () => {
  afterEach(() => {
    cleanup()
    document.body.removeAttribute('data-ds-dark-theme')
  })

  it('audits every exported component', () => {
    expect(Object.keys(AUDITED).sort()).toEqual(exportedComponentNames())
  })

  it.each(['light', 'dark'])('renders no accessibility violations in %s theme and holds the aggregate score', async (theme) => {
    document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
    const audits: SurfaceAudit[] = []
    for (const [surface, mount] of Object.entries(AUDITED)) {
      // A `main` landmark is what the product's page shell provides; without
      // one every surface would fail the page-structure rules for a reason
      // that belongs to the harness rather than to the component.
      const { baseElement } = render(<main>{mount()}</main>)
      audits.push(await auditSurface(surface, baseElement))
      cleanup()
    }

    // A surface that decided nothing scores 100 for free, so every surface has
    // to have actually been examined before the aggregate means anything.
    for (const audit of audits) {
      expect(audit.passed + audit.failed, `${audit.surface} decided no checks`).toBeGreaterThan(0)
    }

    expect(audits.filter(audit => audit.undecidedRules.length > 0)).toEqual([])

    expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
