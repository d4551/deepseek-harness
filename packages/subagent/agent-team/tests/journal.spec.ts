import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { foldTeam } from '../src/fold.ts'
import { TeamJournal } from '../src/journal.ts'
import { TeamId, TeamTaskId } from '../src/types.ts'

async function setup() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const lead = ctx.agentLoop.create(SessionId('journal-lead'), {})
  const committed: SessionId[] = []
  const journal = new TeamJournal(ctx, (root) => { committed.push(root.id) })
  return { ctx, lead, journal, committed }
}

it('matches complete replay as conversation and task history grow', async () => {
  const { lead, journal } = await setup()
  expect(journal.state(lead)).toEqual(foldTeam(lead.id, lead.session.events))
  for (let revision = 1; revision <= 20; revision += 1) {
    lead.session.append('turn/start', { turn: revision })
    lead.session.append('team/task', {
      version: 1,
      teamId: TeamId(lead.id),
      task: {
        id: TeamTaskId('task-7'), revision, subject: `Task ${revision}`,
        description: '', status: 'pending', blockedBy: [], writeScopes: [],
      },
    })
    const expected = foldTeam(lead.id, lead.session.events)
    expect(journal.state(lead)).toEqual(expected)
    expect(journal.state(lead)).toEqual(expected)
  }
})

it('keeps returned maps and nested task values detached from later reads', async () => {
  const { lead, journal } = await setup()
  lead.session.append('team/task', {
    version: 1,
    teamId: TeamId(lead.id),
    task: {
      id: TeamTaskId('task-1'), revision: 1, subject: 'Original',
      description: '', status: 'pending', blockedBy: [], writeScopes: ['src'],
    },
  })
  const first = journal.state(lead)
  const task = first.tasks.get(TeamTaskId('task-1'))!
  task.writeScopes.push('outside')
  first.tasks.clear()
  first.nextTaskNumber = 900
  expect(journal.state(lead)).toEqual(foldTeam(lead.id, lead.session.events))
})

it('preserves replay state when the event boundary rejects an invalid revision', async () => {
  const { lead, journal } = await setup()
  journal.state(lead)
  expect(() => lead.session.append('team/task', {
    version: 1,
    teamId: TeamId(lead.id),
    task: {
      id: TeamTaskId('task-1'), revision: 2, subject: 'Invalid',
      description: '', status: 'pending', blockedBy: [], writeScopes: [],
    },
  })).toThrow('must begin at revision 1')
  expect(journal.state(lead)).toEqual(foldTeam(lead.id, lead.session.events))
  expect(journal.state(lead).tasks.size).toBe(0)
})

it('separates exact live sessions even when their durable identities match', async () => {
  const { lead, journal } = await setup()
  const second = await setup()
  lead.session.append('team/task', {
    version: 1,
    teamId: TeamId(lead.id),
    task: {
      id: TeamTaskId('task-1'), revision: 1, subject: 'First runtime',
      description: '', status: 'pending', blockedBy: [], writeScopes: [],
    },
  })
  expect(journal.state(lead).tasks.size).toBe(1)
  expect(journal.state(second.lead).tasks.size).toBe(0)
  expect(journal.state(lead).tasks.size).toBe(1)
})
