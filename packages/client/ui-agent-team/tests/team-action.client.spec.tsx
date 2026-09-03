// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamTaskId, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import {
  TeamAction, SESSION, actions, props, task, taskSuccess, view,
} from './team-fixtures.client.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('TeamAction load and refresh ordering', () => {
  it('ignores a stale Team load after the conversation switches sessions', async () => {
    const nextSession = 'next-lead' as SessionId
    const firstLoad = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const nextView: TeamView = {
      ...view,
      members: [{ id: nextSession, name: 'lead', role: 'lead', status: 'idle', diagnostics: [] }],
      tasks: [{ ...task, id: 'task-next' as TeamTaskId, subject: 'Next session task' }],
    }
    const load = vi.fn((sessionId: SessionId) => sessionId === SESSION
      ? firstLoad.promise
      : Promise.resolve({ ok: true as const, value: nextView }))
    const injected = actions({ load })
    const rendered = render(<TeamAction {...props(injected)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await waitFor(() => { expect(load).toHaveBeenCalledWith(SESSION) })

    rendered.rerender(<TeamAction {...props(injected, nextSession)} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    expect(await screen.findByText('Next session task')).toBeTruthy()
    firstLoad.resolve({ ok: true, value: view })
    await Promise.resolve()

    await waitFor(() => {
      expect(screen.getByText('Next session task')).toBeTruthy()
      expect(screen.queryByText('Implement runtime')).toBeNull()
    })
  })

  it('loads roster/task diagnostics on open and navigates a healthy teammate', async () => {
    const openTeammate = vi.fn(() => Promise.resolve())
    render(<TeamAction {...props(actions({ openTeammate }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    const worker = await screen.findByRole('button', { name: /worker/u })
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    fireEvent.click(worker)
    await waitFor(() => { expect(openTeammate).toHaveBeenCalledWith(SESSION, view.members[1]) })
  })

  it('keeps only the newest overlapping refresh for one session', async () => {
    const older = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const newer = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const newestView = {
      ...view,
      tasks: [{ ...task, id: 'newest-task' as TeamTaskId, subject: 'Newest task' }],
    }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise)
    render(<TeamAction {...props(actions({ load }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    const refresh = screen.getByRole('button', { name: zh.refresh })
    fireEvent.click(refresh)
    fireEvent.click(refresh)
    newer.resolve({ ok: true, value: newestView })
    expect(await screen.findByText('Newest task')).toBeTruthy()
    older.resolve({ ok: true, value: view })
    await Promise.resolve()

    expect(screen.getByText('Newest task')).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

  it('keeps a successful task mutation newer than an in-flight refresh', async () => {
    const stale = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const completedView = { ...view, tasks: [{ ...task, revision: 2, status: 'completed' as const }] }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ ok: true, value: completedView })
    const updateTask = vi.fn(() => Promise.resolve(
      taskSuccess({ ...task, revision: 2, status: 'completed' }),
    ))
    render(<TeamAction {...props(actions({ load, updateTask }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.click(screen.getByRole('button', { name: /完成/u }))
    expect(await screen.findByRole('button', { name: /重开/u })).toBeTruthy()

    stale.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByRole('button', { name: /重开/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /完成/u })).toBeNull()
  })

  it('keeps a created task newer than an in-flight refresh', async () => {
    const stale = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const createdTask = { ...task, id: 'task-2' as TeamTaskId, subject: 'New task' }
    const load = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: view })
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce({ ok: true, value: { ...view, tasks: [...view.tasks, createdTask] } })
    render(<TeamAction {...props(actions({
      load,
      createTask: () => Promise.resolve(taskSuccess(createdTask)),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText('Implement runtime')

    fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.click(screen.getByRole('button', { name: /新建任务/u }))
    fireEvent.change(screen.getByPlaceholderText('任务标题'), { target: { value: 'New task' } })
    fireEvent.change(screen.getByPlaceholderText('任务描述'), { target: { value: 'Details' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('New task')).toBeTruthy()

    stale.resolve({ ok: true, value: view })
    await Promise.resolve()
    expect(screen.getByText('New task')).toBeTruthy()
  })
})
