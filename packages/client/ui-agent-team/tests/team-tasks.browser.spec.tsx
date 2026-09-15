import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamOverview, TeamTaskView } from '@deepseek-ai/dsh-agent-team/client'
import { TeamTaskId } from '../../../subagent/agent-team/src/types.ts'
import { TeamTasks } from '../src/client/TeamTasks.tsx'
import { en, type TeamKey } from '../src/client/locales.ts'

afterEach(cleanup)

const translate = (key: TeamKey): string => en[key]
const pending: TeamTaskView = {
  id: TeamTaskId('ready-task'), revision: 1, subject: 'Ready review',
  description: 'Review the completed changes', status: 'pending', ready: true,
  blockedBy: [], writeScopes: [], writeScopeWarnings: [],
}

it('announces an empty board without inventing work from an empty workspace board', async () => {
  const view: TeamOverview = {
    tasks: [], members: [], messages: [],
    workspaceTasks: [{ sessionId: SessionId('empty-peer'), tasks: [] }],
  }
  render(<main><TeamTasks view={view} t={translate} /></main>)
  const region = screen.getByRole('region', { name: en.tasks })
  expect(within(region).getByText(en.empty)).toBeVisible()
  expect(within(region).getByText('0')).toBeVisible()
  expect(within(region).queryByText(en.untitledConversation)).toBeNull()
  const audit = await auditSurface('empty shared tasks', region)
  expect(audit.incomplete).toEqual([])
  expect(audit.violations).toEqual([])
  expect(accessibilityFailures([audit], 100)).toBe('')
})

it('retains workspace ownership, counts every task, and renders all committed task states accessibly', async () => {
  const peerId = SessionId('review-conversation')
  const view: TeamOverview = {
    members: [
      { id: SessionId('lead'), name: 'lead', role: 'lead', status: 'idle', diagnostics: [] },
      { id: peerId, name: `session:${peerId}`, title: 'Workspace review', role: 'peer', status: 'idle', diagnostics: [] },
    ],
    messages: [],
    tasks: [{ ...pending, id: TeamTaskId('implementation'), subject: 'Implement change', status: 'in_progress', ownerName: 'lead' }],
    workspaceTasks: [
      { sessionId: SessionId('empty-peer'), tasks: [] },
      { sessionId: peerId, tasks: [
        pending,
        { ...pending, id: TeamTaskId('blocked-task'), subject: 'Blocked review', ready: false,
          blockedBy: [TeamTaskId('implementation')], writeScopes: ['src/review'],
          writeScopeWarnings: ['Another active task owns src/review'] },
        { ...pending, id: TeamTaskId('completed-task'), subject: 'Finished review', status: 'completed', ownerName: 'reviewer' },
        { ...pending, id: TeamTaskId('deleted-task'), subject: 'Removed review', status: 'deleted' },
      ] },
    ],
  }
  render(<main><TeamTasks view={view} t={translate} /></main>)
  const region = screen.getByRole('region', { name: en.tasks })
  const content = within(region)
  expect(content.getByText('5')).toBeVisible()
  expect(content.queryByText(en.empty)).toBeNull()
  expect(content.getByText('Workspace review')).toBeVisible()
  expect(content.queryByText(en.untitledConversation)).toBeNull()
  for (const subject of ['Implement change', 'Ready review', 'Blocked review', 'Finished review', 'Removed review']) {
    expect(content.getByText(subject)).toBeVisible()
  }
  for (const status of [en['status.in_progress'], en['status.completed'], en['status.deleted'], en.ready, en.blocked]) {
    expect(content.getByText(status)).toBeVisible()
  }
  expect(content.getAllByText(en['status.pending'])).toHaveLength(2)
  expect(content.getByText(`${en.owner}: lead`)).toBeVisible()
  expect(content.getByText(`${en.owner}: reviewer`)).toBeVisible()
  expect(content.getAllByText(`${en.owner}: ${en.unowned}`)).toHaveLength(3)
  expect(content.getByText(`${en.blockedBy}: implementation`)).toBeVisible()
  expect(content.getByText(`${en.writeScopes}: src/review`)).toBeVisible()
  expect(content.getByText('Another active task owns src/review')).toBeVisible()
  const audit = await auditSurface('workspace shared task states', region)
  expect(audit.incomplete).toEqual([])
  expect(audit.violations).toEqual([])
  expect(accessibilityFailures([audit], 100)).toBe('')
})
