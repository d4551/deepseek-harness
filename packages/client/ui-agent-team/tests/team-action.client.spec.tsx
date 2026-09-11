// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamTaskId, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import {
  TeamAction, SESSION, actions, props, task, view,
} from './team-fixtures.client.ts'
import { zh } from '../src/client/locales.ts'
import { TeamActivity } from '../../../subagent/agent-team/src/activity.ts'
import { TeamId } from '../../../subagent/agent-team/src/types.ts'

afterEach(cleanup)

describe('TeamAction load and refresh ordering', () => {
  it('populates descendant conversations from Team activity without a refresh gesture', async () => {
    const activity = new TeamActivity()
    let descendants: TeamView['subagents'] = []
    render(<TeamAction {...props(actions({
      changes: (session, signal) => activity.changes(TeamId(session), signal),
      load: () => Promise.resolve({ ok: true, value: { ...view } }),
      loadConversations: () => Promise.resolve({ ok: true, value: descendants }),
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await screen.findByText(zh.noSubagents)
    expect(screen.queryByRole('button', { name: zh.refreshConversations })).toBeNull()
    descendants = [{
      kind: 'child', id: SessionId('new-worker'), parentId: SESSION, depth: 1,
      mode: 'continuable', activity: 'running', label: 'Automatic review', hasChildren: false,
    }]
    activity.notify(TeamId(SESSION))
    expect(await screen.findByRole('button', { name: `${zh.open}: Automatic review` })).toBeTruthy()
    expect(screen.getByText(`${zh.parent}: lead · ${zh['memberStatus.running']}`)).toBeTruthy()
    descendants = descendants.map(entry => entry.kind === 'child' ? { ...entry, activity: 'inactive' } : entry)
    activity.notify(TeamId(SESSION))
    expect(await screen.findByText(`${zh.parent}: lead · ${zh['memberStatus.inactive']}`)).toBeTruthy()
  })

  it('refreshes external Team changes and stops the subscription when closed', async () => {
    const activity = new TeamActivity()
    let current = view
    const load = vi.fn(() => Promise.resolve({ ok: true as const, value: current }))
    const changes = vi.fn((sessionId: SessionId, signal: AbortSignal) =>
      activity.changes(TeamId(sessionId), signal))
    render(<TeamAction {...props(actions({ load, changes }))} />)
    const trigger = screen.getByRole('button', { name: /Agent Team/u })
    expect(changes).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    await screen.findByText('Implement runtime')
    current = { ...view, tasks: [{ ...task, revision: 2, subject: 'Updated by teammate' }] }
    activity.notify(TeamId(SESSION))
    expect(await screen.findByText('Updated by teammate')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
    fireEvent.click(trigger)
    expect(changes.mock.calls[0]?.[1].aborted).toBe(true)
    activity.notify(TeamId(SESSION))
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    fireEvent.click(trigger)
    expect(await screen.findByText('Updated by teammate')).toBeTruthy()
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('coalesces activity while a view request is pending', async () => {
    let sent = 0
    const first = Promise.withResolvers<{ ok: true; value: TeamView }>()
    const load = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, value: { ...view, tasks: [{ ...task, subject: 'Latest state' }] } })
    render(<TeamAction {...props(actions({
      load,
      async *changes(_sessionId, signal) {
        for (let revision = 0; revision <= 100; revision += 1) {
          sent = revision
          yield revision
        }
        if (signal.aborted) return
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      },
    }))} />)
    fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
    await waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(sent).toBe(100) })
    expect(load).toHaveBeenCalledOnce()
    first.resolve({ ok: true, value: view })
    expect(await screen.findByText('Latest state')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

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
    await waitFor(() => { expect(load).toHaveBeenCalledWith(SESSION, expect.any(AbortSignal)) })

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
    expect(refresh.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByText(zh.loading)).toBeNull()
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    fireEvent.click(refresh)
    newer.resolve({ ok: true, value: newestView })
    expect(await screen.findByText('Newest task')).toBeTruthy()
    older.resolve({ ok: true, value: view })
    await Promise.resolve()

    expect(screen.getByText('Newest task')).toBeTruthy()
    expect(screen.queryByText('Implement runtime')).toBeNull()
  })

})
