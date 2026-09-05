// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamTaskId, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { TeamAction, actions, props, task, view } from './team-fixtures.client.ts'
import type { TeamActionInjected } from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

const MINIMUM_ACCESSIBILITY_SCORE = 100

afterEach(cleanup)

async function assertPanelAccessible(load: TeamActionInjected['load']): Promise<void> {
  render(<TeamAction {...props(actions({ load }))} />)
  const toggle = screen.getByRole('button', { name: /Agent Team/u })
  fireEvent.click(toggle)
  const audits = [
    await auditSurface('team toggle', toggle),
    await auditSurface('team panel', screen.getByRole('dialog')),
  ]
  expect(accessibilityFailures(audits, MINIMUM_ACCESSIBILITY_SCORE)).toBe('')
}

describe('TeamAction accessibility', () => {
  it('renders an accessible toggle and open panel', async () => {
    await assertPanelAccessible(actions().load)
    await screen.findByText('Implement runtime')
    expect(screen.getByRole('combobox', { name: zh.owner })).toBeTruthy()
  })

  it('moves focus into the dialog and restores it when closed', async () => {
    render(<TeamAction {...props(actions())} />)
    const toggle = screen.getByRole('button', { name: /Agent Team/u })
    fireEvent.click(toggle)

    const dialog = screen.getByRole('dialog')
    await waitFor(() => { expect(document.activeElement).toBe(dialog) })
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(document.activeElement).toBe(toggle)
  })

  it('renders ready, blocked, and completed task variants accessibly', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const richView: TeamView = {
      ...view,
      tasks: [
        { ...unownedTask, id: 'ready-task' as TeamTaskId, subject: 'Ready task', status: 'pending', ready: true },
        { ...unownedTask, id: 'blocked-task' as TeamTaskId, subject: 'Blocked task', status: 'pending', ready: false },
        { ...task, id: 'completed-task' as TeamTaskId, subject: 'Completed task', status: 'completed' },
      ],
    }
    await assertPanelAccessible(() => Promise.resolve({ ok: true, value: richView }))
    expect(await screen.findByText('Ready task')).toBeTruthy()
    expect(screen.getByText('Blocked task')).toBeTruthy()
    expect(screen.getByText('Completed task')).toBeTruthy()
  })

  it('keeps a failed-member diagnostic accessible alongside the roster', async () => {
    const failedView: TeamView = {
      ...view,
      members: [
        ...view.members,
        {
          id: 'failed-id' as SessionId,
          name: 'failed-worker',
          role: 'teammate',
          status: 'failed',
          diagnostics: ['provider failed'],
        },
      ],
    }
    await assertPanelAccessible(() => Promise.resolve({ ok: true, value: failedView }))
    await screen.findByText('provider failed')
  })
})
