import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import TeamService, { TeamId, TeamMessageId } from '../src/index.ts'
import { workspacePeerName } from '../src/workspace-peers.ts'

it('discovers registered workspace conversations and admits durable messages only while membership holds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-team-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const cwd = join(root, 'workspace')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(cwd)
  await mkdir(elsewhere)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionQuery, { path: join(root, 'query.sqlite') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(TeamService)
  const lead = (await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd }, agentOptions: {} })).agent
  const peer = (await ctx.agents.create({ sessionId: SessionId('second'), meta: { cwd }, agentOptions: {} })).agent
  const foreign = (await ctx.agents.create({ sessionId: SessionId('foreign'), meta: { cwd: elsewhere }, agentOptions: {} })).agent
  const inactive = ctx.sessions.create(SessionId('inactive'), { meta: { cwd } })
  await ctx.sessions.flush(inactive)
  expect(ctx.agentTeams.listMembers(lead).map(member => member.id)).toEqual([lead.id])
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'workspaces.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(WorkspaceRegistry)
  const workspace = await ctx.workspaceRegistry.create(cwd)
  await workspace.attachSession(lead.id)
  await workspace.attachSession(peer.id)
  await workspace.attachSession(inactive.id)
  const otherWorkspace = await ctx.workspaceRegistry.create(elsewhere)
  await otherWorkspace.attachSession(foreign.id)
  expect(ctx.agentTeams.listMembers(lead).map(member => member.id)).toEqual([lead.id, peer.id])
  expect(ctx.agentTeams.listMembers(lead)[1]).toEqual({
    id: peer.id, name: workspacePeerName(peer.id), role: 'peer', status: 'idle', diagnostics: [],
  })
  expect(ctx.agentTeams.listMembers(peer).map(member => member.id)).toEqual([peer.id, lead.id])
  expect(ctx.agentTeams.listMembers(foreign).map(member => member.id)).toEqual([foreign.id])
  const signal = new AbortController().signal
  const message = {
    target: workspacePeerName(peer.id),
    content: [{ type: 'text', text: 'I own the settings files; coordinate changes before editing them.' }],
    delivery: 'quiet',
    signal,
  } satisfies Parameters<TeamService['sendMessage']>[1]
  const sent = await ctx.agentTeams.sendMessage(lead, message)
  expect(sent.status).toBe('accepted')
  expect(peer.status).toBe('idle')
  expect(peer.inbox.nextStep.map(item => item.source)).toEqual([{
    kind: 'team-message',
    teamId: TeamId(lead.id),
    messageId: sent.messageId,
    senderId: lead.id,
    senderName: workspacePeerName(lead.id),
  }])
  expect((await ctx.agentTeams.remoteView(lead)).messages).toEqual([
    expect.objectContaining({ id: sent.messageId, targetId: peer.id, delivered: true }),
  ])
  await expect(ctx.agentTeams.sendMessage(foreign, message)).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  const detached = ctx.agentTeams.waitForChange(lead, 10_000, signal)
  await workspace.detachSession(peer.id)
  expect(await detached).toEqual({ timedOut: false })
  expect(ctx.agentTeams.listMembers(lead).map(member => member.id)).toEqual([lead.id])
  await expect(ctx.agentTeams.sendMessage(lead, message)).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  const pendingId = TeamMessageId('workspace-recovery-message')
  lead.session.append('team/message/queued', {
    version: 1,
    teamId: TeamId(lead.id),
    message: {
      id: pendingId,
      senderId: lead.id,
      senderName: workspacePeerName(lead.id),
      targetId: peer.id,
      delivery: message.delivery,
      content: message.content,
    },
  })
  await ctx.sessions.flush(lead.session)
  expect(peer.inbox.nextStep).toHaveLength(1)
  await workspace.attachSession(peer.id)
  await vi.waitFor(() => {
    expect(peer.inbox.nextStep.map(item => item.source)).toEqual([
      expect.objectContaining({ messageId: sent.messageId }),
      expect.objectContaining({ messageId: pendingId }),
    ])
  })
  await vi.waitFor(async () => {
    expect((await ctx.agentTeams.remoteView(lead)).messages).toEqual([
      expect.objectContaining({ id: sent.messageId, delivered: true }),
      expect.objectContaining({ id: pendingId, delivered: true }),
    ])
  })
  const archived = ctx.agentTeams.waitForChange(lead, 10_000, signal)
  await ctx.workspaceRegistry.archiveSession(peer.id)
  expect(await archived).toEqual({ timedOut: false })
  expect(ctx.agentTeams.listMembers(lead).map(member => member.id)).toEqual([lead.id])
  await expect(ctx.agentTeams.sendMessage(lead, message)).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  expect((await ctx.agentTeams.remoteView(lead)).messages).toHaveLength(2)
  await expect(ctx.agentTeams.sendMessage(peer, {
    ...message, target: workspacePeerName(lead.id),
  })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
})
