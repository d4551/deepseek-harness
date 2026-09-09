import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamView } from '@deepseek-ai/dsh-agent-team/client'
import { TeamTaskId } from '../../../subagent/agent-team/src/types.ts'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { TeamAction, actions, props, task, taskSuccess, view, type TeamTaskActionResult } from './team-fixtures.client.ts'
import type { TeamActionInjected } from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

const MINIMUM_ACCESSIBILITY_SCORE = 100

afterEach(cleanup)

async function assertPanelAccessible(load: TeamActionInjected['load']): Promise<void> {
  render(<TeamAction {...props(actions({ load }))} />)
  const toggle = screen.getByRole('button', { name: /Agent Team/u })
  const toggleAudit = await auditSurface('team toggle', toggle)
  fireEvent.click(toggle)
  expect(toggle.closest('[inert]')).not.toBeNull()
  const audits = [
    toggleAudit,
    await auditSurface('team panel', screen.getByRole('dialog')),
  ]
  for (const audit of audits) expect(audit.incomplete).toEqual([])
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
    toggle.focus()
    fireEvent.click(toggle)

    const dialog = screen.getByRole('dialog')
    await waitFor(() => { expect(document.activeElement).toBe(dialog) })
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(document.activeElement).toBe(toggle)
  })

  it('labels populated fields and prevents changes or duplicate submission during a save', async () => {
    const saved = Promise.withResolvers<TeamTaskActionResult>()
    let submissions = 0
    render(<TeamAction {...props(actions({ createTask: () => {
      submissions += 1
      return saved.promise
    } }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.click(screen.getByRole('button', { name: zh.create }))
    const subject = screen.getByRole<HTMLInputElement>('textbox', { name: zh.subject })
    const description = screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh.description })
    fireEvent.change(subject, { target: { value: 'Labeled task' } })
    fireEvent.change(description, { target: { value: 'Keyboard submission' } })
    const form = subject.form
    if (form === null) throw new Error('Task fields must belong to a form')
    fireEvent.submit(form)
    expect(submissions).toBe(1)
    for (const field of screen.getAllByRole<HTMLInputElement>('textbox')) expect(field.disabled).toBe(true)
    fireEvent.submit(form)
    expect(submissions).toBe(1)
    saved.resolve(taskSuccess(task))
    await waitFor(() => { expect(screen.queryByRole('textbox', { name: zh.subject })).toBeNull() })
  })

  it('dismisses the panel when the user points outside it', async () => {
    render(<TeamAction {...props(actions())} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders ready, blocked, and completed task variants accessibly', async () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const richView: TeamView = {
      ...view,
      tasks: [
        { ...unownedTask, id: TeamTaskId('ready-task'), subject: 'Ready task', status: 'pending', ready: true },
        { ...unownedTask, id: TeamTaskId('blocked-task'), subject: 'Blocked task', status: 'pending', ready: false },
        { ...task, id: TeamTaskId('completed-task'), subject: 'Completed task', status: 'completed' },
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
          id: SessionId('failed-id'),
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
