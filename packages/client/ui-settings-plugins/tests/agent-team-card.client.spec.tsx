// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AgentTeamCard } from '../src/client/AgentTeamCard.tsx'
import type { AgentTeamCardProps } from '../src/client/AgentTeamCard.tsx'
import type { AgentTeamCardState } from '../src/client/agent-team-card-controller.ts'
import { en } from '../src/client/locales.ts'
import { cardActions, field, settled, t } from './section-support.client.tsx'
import { cardProps } from './props.client.ts'

afterEach(cleanup)

function renderAgentTeam(state: Partial<AgentTeamCardState> = {}, landmark = false) {
  const store = createSnapshotStore<AgentTeamCardState>({
    ...settled,
    maxMembers: field('16'),
    maxTasks: field('256'),
    ...state,
  })
  const actions = cardActions()
  const props = cardProps<AgentTeamCardProps>({
    ...actions,
    t,
    useAgentTeamCard: bindSnapshotSelector(store),
  })
  // The card is one list item; the audit needs the landmark and list its
  // section supplies in the running page.
  render(landmark ? <main><ul><AgentTeamCard {...props} /></ul></main> : <AgentTeamCard {...props} />)
  return actions
}

describe('AgentTeamCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    renderAgentTeam({ available: false })

    expect(screen.queryByText(en.agentTeamTitle)).toBeNull()
  })

  it('stages and saves both capacities', () => {
    const actions = renderAgentTeam({ dirty: true })

    fireEvent.click(screen.getByText(en.agentTeamTitle))
    fireEvent.change(screen.getByLabelText(en.agentTeamMaxMembers), { target: { value: '24' } })
    fireEvent.change(screen.getByLabelText(en.agentTeamMaxTasks), { target: { value: '512' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('maxMembers', '24')
    expect(actions.edit).toHaveBeenCalledWith('maxTasks', '512')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for an overridden capacity', () => {
    const actions = renderAgentTeam({ maxTasks: field('512', { overridden: true }) })

    fireEvent.click(screen.getByText(en.agentTeamTitle))
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('maxTasks')
  })

  it('shows the invalid draft in place of the hint', () => {
    renderAgentTeam({ maxMembers: field('lots', { invalid: true }) })

    fireEvent.click(screen.getByText(en.agentTeamTitle))

    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
  })

  it('names and disables both controls when the settings document is read-only', () => {
    renderAgentTeam({
      writable: false,
      maxTasks: field('512', { overridden: true }),
    })

    fireEvent.click(screen.getByText(en.agentTeamTitle))

    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect(screen.getByRole('textbox', { name: en.agentTeamMaxMembers })).toHaveProperty('disabled', true)
    expect(screen.getByRole('textbox', { name: en.agentTeamMaxTasks })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.reset })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })
})

describe('agent-team card accessibility', () => {
  const MINIMUM_ACCESSIBILITY_SCORE = 100

  it('renders both capacity controls with no violations', async () => {
    renderAgentTeam({ maxTasks: field('512', { overridden: true }) }, true)
    fireEvent.click(screen.getByText(en.agentTeamTitle))

    const audit = await auditSurface('AgentTeamCard', document.body)
    expect(audit.passed + audit.failed).toBeGreaterThan(0)

    expect(accessibilityFailures([audit], MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
  })
})
