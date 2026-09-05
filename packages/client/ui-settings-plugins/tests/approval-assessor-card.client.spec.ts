// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ApprovalAssessorCard } from '../src/client/ApprovalAssessorCard.tsx'
import type { ApprovalAssessorCardProps } from '../src/client/ApprovalAssessorCard.tsx'
import type { ApprovalAssessorCardState } from '../src/client/approval-assessor-card-controller.ts'
import { en } from '../src/client/locales.ts'
import { cardActions, field, settled, t } from './section-support.client.tsx'
import { cardProps } from './props.client.ts'

afterEach(cleanup)

function renderCard(state: Partial<ApprovalAssessorCardState> = {}) {
  const store = createSnapshotStore<ApprovalAssessorCardState>({
    ...settled,
    enabled: field('true'),
    extraPhrases: field(''),
    ...state,
  })
  const actions = cardActions()
  const props = cardProps<ApprovalAssessorCardProps>({
    ...actions,
    t,
    useApprovalAssessorCard: bindSnapshotSelector(store),
  })
  render(createElement('main', {}, createElement('ul', {}, createElement(ApprovalAssessorCard, props))))
  return actions
}

describe('ApprovalAssessorCard', () => {
  it('stages enforcement and additional phrases', () => {
    const actions = renderCard({ dirty: true })
    fireEvent.click(screen.getByText(en.approvalAssessorTitle))

    fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.approvalAssessorEnabledOff) }))
    fireEvent.change(screen.getByLabelText(en.approvalAssessorExtraPhrases), {
      target: { value: 'skip this\ndefer that' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('enabled', 'false')
    expect(actions.edit).toHaveBeenCalledWith('extraPhrases', 'skip this\ndefer that')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('renders nothing before the namespace is served', () => {
    renderCard({ available: false })
    expect(screen.queryByText(en.approvalAssessorTitle)).toBeNull()
  })

  it('has no accessibility violations when expanded', async () => {
    renderCard({ extraPhrases: field('custom', { overridden: true }) })
    fireEvent.click(screen.getByText(en.approvalAssessorTitle))

    const audit = await auditSurface('ApprovalAssessorCard', document.body)
    expect(audit.passed + audit.failed).toBeGreaterThan(0)
    expect(accessibilityFailures([audit], 100)).toBe('')
  })

  it('associates field guidance and preserves read-only controls', () => {
    renderCard({
      writable: false,
      dirty: true,
      enabled: field('true', { overridden: true }),
      extraPhrases: field('custom', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.approvalAssessorTitle))

    const group = screen.getByRole('group', { name: en.approvalAssessorEnabled })
    const hintId = group.getAttribute('aria-describedby')
    expect(hintId).toBeTruthy()
    expect(document.getElementById(hintId ?? '')?.textContent).toBe(en.approvalAssessorEnabledHint)
    expect(screen.getAllByRole('radio').every(control => control.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByLabelText(en.approvalAssessorExtraPhrases)).toHaveProperty('disabled', true)
    expect(screen.getAllByRole('button', { name: en.reset })
      .every(control => control.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })
})
