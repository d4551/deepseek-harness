// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ApprovalAssessorCard } from '../src/client/ApprovalAssessorCard.tsx'
import type { ApprovalAssessorCardProps } from '../src/client/ApprovalAssessorCard.tsx'
import type { ApprovalAssessorCardState } from '../src/client/approval-assessor-card-controller.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: CardShell = {
  available: true,
  writable: true,
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

describe('ApprovalAssessorCard', () => {
  function renderApprovalAssessor(state: Partial<ApprovalAssessorCardState> = {}) {
    const store = createSnapshotStore<ApprovalAssessorCardState>({
      ...settled,
      enabled: field('true'),
      extraPatterns: field(''),
      ...state,
    })
    const actions = cardActions()
    const props = {
      ...actions,
      t,
      useApprovalAssessorCard: bindSnapshotSelector(store),
    } as never as ApprovalAssessorCardProps
    render(<main><ul><ApprovalAssessorCard {...props} /></ul></main>)
    return { actions, store }
  }

  it('renders nothing while its namespace is unavailable', () => {
    renderApprovalAssessor({ available: false })

    expect(screen.queryByText(en.approvalAssessorTitle)).toBeNull()
  })

  it('stages edits for both fields when saved', () => {
    const { actions } = renderApprovalAssessor({ dirty: true })
    fireEvent.click(screen.getByText(en.approvalAssessorTitle))

    fireEvent.change(screen.getByLabelText(en.approvalAssessorEnabled), { target: { value: 'false' } })
    fireEvent.change(screen.getByLabelText(en.approvalAssessorExtraPatterns), { target: { value: 'known issue' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('enabled', 'false')
    expect(actions.edit).toHaveBeenCalledWith('extraPatterns', 'known issue')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for an overridden field', () => {
    const { actions } = renderApprovalAssessor({ extraPatterns: field('known issue', { overridden: true }) })
    fireEvent.click(screen.getByText(en.approvalAssessorTitle))

    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('extraPatterns')
  })

  it('stages a reset for the screening switch itself', () => {
    const { actions } = renderApprovalAssessor({ enabled: field('true', { overridden: true }) })
    fireEvent.click(screen.getByText(en.approvalAssessorTitle))

    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('enabled')
  })

  it('shows the invalid draft in place of the hint', () => {
    renderApprovalAssessor({ enabled: field('maybe', { invalid: true }) })
    fireEvent.click(screen.getByText(en.approvalAssessorTitle))

    expect(screen.getByText(en.invalidBoolean)).toBeTruthy()
  })
})

describe('approval-assessor card accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders the screening switch and pattern field with no violations', async () => {
    const store = createSnapshotStore<ApprovalAssessorCardState>({
      ...settled,
      enabled: field('true'),
      extraPatterns: field('known issue', { overridden: true }),
    })
    const props = {
      ...cardActions(),
      t,
      useApprovalAssessorCard: bindSnapshotSelector(store),
    } as never as ApprovalAssessorCardProps
    render(<main><ul><ApprovalAssessorCard {...props} /></ul></main>)
    fireEvent.click(screen.getByText(en.approvalAssessorTitle))

    const audit = await auditSurface('ApprovalAssessorCard', document.body)
    expect(audit.passed + audit.failed).toBeGreaterThan(0)

    expect(accessibilityFailures([audit], MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
