// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UpdateTeamTaskRequest } from '@deepseek-ai/dsh-agent-team/client'
import { TeamAction, actions, props, task, taskConflict, taskRejected, taskSuccess, view } from './team-fixtures.client.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

it('keeps the revision that the user opened when another member edits the task', async () => {
  let current = task
  const requests: UpdateTeamTaskRequest[] = []
  render(<TeamAction {...props(actions({
    load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [current] } }),
    updateTask: (_session, input) => {
      requests.push(input)
      return Promise.resolve(taskConflict('Task changed'))
    },
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText(task.subject)
  fireEvent.click(screen.getByRole('button', { name: zh.edit }))
  const subject = screen.getByRole<HTMLInputElement>('textbox', { name: zh.subject })
  expect(document.activeElement).toBe(subject)
  fireEvent.change(subject, { target: { value: 'My draft' } })
  current = { ...task, revision: 2, subject: 'Another member’s edit' }
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(screen.queryByRole('status')).toBeNull() })
  fireEvent.click(screen.getByRole('button', { name: zh.save }))
  await screen.findByRole('alert')
  expect(requests).toEqual([{
    taskId: task.id, expectedRevision: 1, action: 'edit',
    subject: 'My draft', description: task.description, writeScopes: task.writeScopes,
  }])
  expect(subject.value).toBe('My draft')
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(screen.getByText(current.subject)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.edit }))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.subject }).value).toBe(current.subject)
})

it('displays the assigned owner when that member cannot accept new tasks', async () => {
  render(<TeamAction {...props(actions({
    load: () => Promise.resolve({
      ok: true,
      value: { ...view, tasks: [{ ...task, ownerName: 'unavailable-worker' }] },
    }),
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText(task.subject)
  const owner = screen.getByRole<HTMLSelectElement>('combobox', { name: zh.owner })
  expect(owner.value).toBe('unavailable-worker')
  expect(owner.selectedOptions[0]?.textContent).toBe('unavailable-worker')
  expect(owner.selectedOptions[0]?.disabled).toBe(true)
})

it('retains the committed edit revision when a dependency update must be retried', async () => {
  let current = task
  const requests: UpdateTeamTaskRequest[] = []
  render(<TeamAction {...props(actions({
    load: () => Promise.resolve({ ok: true, value: { ...view, tasks: [current] } }),
    updateTask: (_session, input) => {
      requests.push(input)
      if (input.action === 'set_dependencies') return Promise.resolve(taskRejected('Dependency unavailable'))
      expect(input.expectedRevision).toBe(current.revision)
      current = { ...current, revision: current.revision + 1 }
      return Promise.resolve(taskSuccess(current))
    },
  }))} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText(task.subject)
  fireEvent.click(screen.getByRole('button', { name: zh.edit }))
  fireEvent.change(screen.getByRole('textbox', { name: zh.blockers }), { target: { value: 'task-2' } })
  fireEvent.click(screen.getByRole('button', { name: zh.save }))
  await screen.findByText('Dependency unavailable (team-rejected)')
  fireEvent.click(screen.getByRole('button', { name: zh.save }))
  await waitFor(() => { expect(requests).toHaveLength(4) })
  expect(requests.map(input => [input.action, input.expectedRevision])).toEqual([
    ['edit', 1], ['set_dependencies', 2], ['edit', 2], ['set_dependencies', 3],
  ])
})

it('focuses a new task subject and prevents reopening an active create form', async () => {
  render(<TeamAction {...props(actions())} />)
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
  await screen.findByText(task.subject)
  const create = screen.getByRole<HTMLButtonElement>('button', { name: zh.create })
  fireEvent.click(create)
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: zh.subject }))
  expect(create.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  expect(create.disabled).toBe(false)
})
