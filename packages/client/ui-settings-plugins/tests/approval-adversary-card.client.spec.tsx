// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ApprovalAdversaryCard } from '../src/client/ApprovalAdversaryCard.tsx'
import type { ApprovalAdversaryCardProps } from '../src/client/ApprovalAdversaryCard.tsx'
import type { ApprovalAdversaryCardState } from '../src/client/approval-adversary-card-controller.ts'
import { en } from '../src/client/locales.ts'
import { cardActions, field, settled, t } from './section-support.client.tsx'
import { cardProps } from './props.client.ts'

afterEach(cleanup)

function renderCard(state: Partial<ApprovalAdversaryCardState> = {}) {
  const store = createSnapshotStore<ApprovalAdversaryCardState>({
    ...settled,
    enabled: field('false'),
    provider: field(''),
    model: field(''),
    fallback: field('delegate'),
    timeoutMs: field('30000'),
    maxOutputTokens: field('256'),
    maxExcerptChars: field('4000'),
    instructions: field(''),
    ...state,
  })
  const actions = cardActions()
  const props = cardProps<ApprovalAdversaryCardProps>({
    ...actions,
    t,
    useApprovalAdversaryCard: bindSnapshotSelector(store),
  })
  render(<main><ul><ApprovalAdversaryCard {...props} /></ul></main>)
  return actions
}

describe('ApprovalAdversaryCard', () => {
  it('stages the reviewer switch, the route, the fallback, the caps, and the instructions', () => {
    const actions = renderCard({ dirty: true })
    fireEvent.click(screen.getByText(en.approvalAdversaryTitle))

    fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.approvalAdversaryEnabledOn) }))
    fireEvent.change(screen.getByLabelText(en.approvalAdversaryProvider), { target: { value: 'deepseek-official' } })
    fireEvent.change(screen.getByLabelText(en.approvalAdversaryModel), { target: { value: 'deepseek-v4-flash' } })
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.approvalAdversaryFallbackReject) }))
    fireEvent.change(screen.getByLabelText(en.approvalAdversaryTimeoutMs), { target: { value: '15000' } })
    fireEvent.change(screen.getByLabelText(en.approvalAdversaryMaxOutputTokens), { target: { value: '128' } })
    fireEvent.change(screen.getByLabelText(en.approvalAdversaryMaxExcerptChars), { target: { value: '2000' } })
    fireEvent.change(screen.getByLabelText(en.approvalAdversaryInstructions), {
      target: { value: 'Deny anything that touches production.' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit.mock.calls).toEqual([
      ['enabled', 'true'],
      ['provider', 'deepseek-official'],
      ['model', 'deepseek-v4-flash'],
      ['fallback', 'reject'],
      ['timeoutMs', '15000'],
      ['maxOutputTokens', '128'],
      ['maxExcerptChars', '2000'],
      ['instructions', 'Deny anything that touches production.'],
    ])
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('offers a reset for every overridden field and stages each clear', () => {
    const actions = renderCard({
      dirty: true,
      enabled: field('true', { overridden: true }),
      provider: field('deepseek-official', { overridden: true }),
      model: field('deepseek-v4-flash', { overridden: true }),
      fallback: field('reject', { overridden: true }),
      timeoutMs: field('15000', { overridden: true }),
      maxOutputTokens: field('128', { overridden: true }),
      maxExcerptChars: field('2000', { overridden: true }),
      instructions: field('custom', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.approvalAdversaryTitle))

    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(8)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.resetField.mock.calls.map(([name]) => name)).toEqual([
      'enabled', 'provider', 'model', 'fallback', 'timeoutMs', 'maxOutputTokens', 'maxExcerptChars', 'instructions',
    ])
  })

  it('offers no reset for an inherited field', () => {
    renderCard({ instructions: field('custom', { overridden: true }) })
    fireEvent.click(screen.getByText(en.approvalAdversaryTitle))

    expect(screen.getAllByRole('button', { name: en.reset })).toHaveLength(1)
  })

  it('explains an incomplete route and blocks saving it', () => {
    renderCard({
      dirty: true,
      invalid: true,
      provider: field('deepseek-official', { invalid: true }),
      model: field('', { invalid: true }),
    })
    fireEvent.click(screen.getByText(en.approvalAdversaryTitle))

    const provider = screen.getByLabelText(en.approvalAdversaryProvider)
    const model = screen.getByLabelText(en.approvalAdversaryModel)
    expect(provider.getAttribute('aria-invalid')).toBe('true')
    expect(model.getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(provider.getAttribute('aria-describedby') ?? '')?.textContent)
      .toBe(en.approvalAdversaryProviderHint)
    expect(document.getElementById(model.getAttribute('aria-describedby') ?? '')?.textContent)
      .toBe(en.approvalAdversaryModelHint)
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByText(en.approvalAdversaryProviderHint)).toBeTruthy()
    expect(screen.getByText(en.approvalAdversaryModelHint)).toBeTruthy()
  })

  it('renders nothing before the namespace is served', () => {
    renderCard({ available: false })
    expect(screen.queryByText(en.approvalAdversaryTitle)).toBeNull()
  })

  it('has no accessibility violations when expanded', async () => {
    renderCard({
      enabled: field('true', { overridden: true }),
      timeoutMs: field('soon', { invalid: true }),
      instructions: field('custom', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.approvalAdversaryTitle))

    const audit = await auditSurface('ApprovalAdversaryCard', document.body)
    expect(audit.passed + audit.failed).toBeGreaterThan(0)
    expect(accessibilityFailures([audit], 100)).toBe('')
  })

  it('associates field guidance and preserves read-only controls', () => {
    renderCard({
      writable: false,
      dirty: true,
      enabled: field('true', { overridden: true }),
      provider: field('deepseek-official', { overridden: true }),
    })
    fireEvent.click(screen.getByText(en.approvalAdversaryTitle))

    const group = screen.getByRole('group', { name: en.approvalAdversaryEnabled })
    const hintId = group.getAttribute('aria-describedby')
    expect(hintId).toBeTruthy()
    expect(document.getElementById(hintId ?? '')?.textContent).toBe(en.approvalAdversaryEnabledHint)
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getAllByRole('radio').every(control => control.hasAttribute('disabled'))).toBe(true)
    expect(screen.getAllByRole('textbox').every(control => control.hasAttribute('disabled'))).toBe(true)
    expect(screen.getAllByRole('button', { name: en.reset })
      .every(control => control.hasAttribute('disabled'))).toBe(true)
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })
})
