// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityScore, auditSurface, formatViolations } from '@deepseek-ai/dsh-client-a11y'
import type { SurfaceAudit } from '@deepseek-ai/dsh-client-a11y'
import * as primitives from '../src/index.ts'
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
 * Aggregate floor for the primitives lane. Raising it is always allowed;
 * lowering it would let a regression land, so it only ever moves up.
 */
const MINIMUM_ACCESSIBILITY_SCORE = 99

const {
  BrandWordmark, Button, CodeBlock, ConnectionBanner, DiffBlock, DisclosureRow, FishLogo, HoverCard,
  Input, JsonBlock, JsonTree, MarkdownText, Menu, MessageText, Modal, OnboardingSurface, Pill,
  ReadBlock, ReferenceIcon, RiskConfirmation, SearchBlock, StateDot, TerminalBlock, Toast, Tooltip,
  WebBlock,
} = primitives

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
  FishLogo: () => <FishLogo size={24} />,
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
  StateDot: () => <StateDot state="ongoing" />,
  TerminalBlock: () => (
    <TerminalBlock command="ls -la" cwd="/repo" output="total 0" exitCode={0} labels={terminalBlockLabels} />
  ),
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
  for (const [name, value] of Object.entries(primitives)) {
    if (!name.startsWith('Icon') || typeof value !== 'function') continue
    const Icon = value as () => ReactElement
    surfaces[name] = () => <Icon />
  }
  return surfaces
}

const AUDITED: Readonly<Record<string, () => ReactElement>> = { ...SURFACES, ...iconSurfaces() }

function exportedComponentNames(): string[] {
  return Object.entries(primitives)
    .filter(([name, value]) => {
      if (!/^[A-Z]/.test(name)) return false
      if (typeof value === 'function') return true
      return typeof value === 'object' && value !== null
        && (value as { $$typeof?: symbol }).$$typeof === MEMO_TAG
    })
    .map(([name]) => name)
    .sort()
}

describe('ui-primitives accessibility', () => {
  afterEach(cleanup)

  it('audits every exported component', () => {
    expect(Object.keys(AUDITED).sort()).toEqual(exportedComponentNames())
  })

  it('renders no accessibility violations and holds the aggregate score', async () => {
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

    // Undecided checks are excluded from the score, so which rules land there
    // is itself an assertion: jsdom computes no layout and therefore cannot
    // decide contrast, and that is the browser lane's to prove. Any other rule
    // arriving here would be silently dropped from the score without this.
    expect([...new Set(audits.flatMap(audit => audit.undecidedRules))]).toEqual(['color-contrast'])

    const failures = audits.map(formatViolations).filter(text => text !== '').join('\n')
    expect(failures).toBe('')
    expect(accessibilityScore(audits)).toBeGreaterThanOrEqual(MINIMUM_ACCESSIBILITY_SCORE)
  })
})
