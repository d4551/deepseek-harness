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
  peer.session.append('request/header', {
    reason: 'initial', header: { config: { provider: 'selected', model: 'peer-selected-model' } },
  })
  expect(ctx.agentTeams.listMembers(lead)[1]?.model).toBe('peer-selected-model')
  expect(ctx.agentTeams.listMembers(peer).map(member => member.id)).toEqual([peer.id, lead.id])
  expect(ctx.agentTeams.listMembers(foreign).map(member => member.id)).toEqual([foreign.id])
  const work = { subject: 'Update settings', description: 'Coordinate the shared settings directory', writeScopes: ['src/settings'] }
  const leadTask = await ctx.agentTeams.createTask(lead, work)
  const peerTask = await ctx.agentTeams.createTask(peer, { ...work, writeScopes: ['src/settings/menu.ts'] })
  expect(ctx.agentTeams.remoteOverview(lead).workspaceTasks).toEqual([{ sessionId: peer.id, tasks: [peerTask] }])
  expect(ctx.agentTeams.workspaceTasks(peer)).toEqual([{ sessionId: lead.id, tasks: [leadTask] }])
  await ctx.agentTeams.createTask(foreign, work)
  expect((await ctx.agentTeams.claimNextReadyTask(foreign)).outcome).toBe('claimed')
  const claims = await Promise.all([
    ctx.agentTeams.claimNextReadyTask(lead),
    ctx.agentTeams.claimNextReadyTask(peer),
  ])
  expect(claims.map(claim => claim.outcome).sort()).toEqual(['claimed', 'none'])
  const owner = claims[0].outcome === 'claimed' ? lead : peer
  const waiting = owner === lead ? peer : lead
  const activeTask = ctx.agentTeams.getTask(owner, owner === lead ? leadTask.id : peerTask.id)
  const waitingTask = ctx.agentTeams.getTask(waiting, waiting === lead ? leadTask.id : peerTask.id)
  expect(waitingTask.writeScopeWarnings).toEqual([
    `write scopes overlap with ${workspacePeerName(owner.id)}/${activeTask.id}`,
  ])
  await expect(ctx.agentTeams.updateTask(waiting, {
    taskId: waitingTask.id, expectedRevision: waitingTask.revision, action: 'claim',
  })).rejects.toMatchObject({ code: 'TEAM_TASK_WRITE_SCOPE_CONFLICT' })
  expect(await ctx.agentTeams.claimNextReadyTask(waiting)).toEqual({
    outcome: 'none', reason: 'write-scope-conflict', deferred: [waitingTask.id],
  })
  await ctx.agentTeams.updateTask(owner, {
    taskId: activeTask.id, expectedRevision: activeTask.revision, action: 'complete',
  })
  expect(ctx.agentTeams.getTask(waiting, waitingTask.id).writeScopeWarnings).toEqual([])
  expect((await ctx.agentTeams.claimNextReadyTask(waiting)).outcome).toBe('claimed')
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
  const reply = await ctx.agentTeams.sendMessage(peer, {
    ...message, target: workspacePeerName(lead.id), content: [{ type: 'text', text: 'I will review the settings changes.' }],
  })
  expect(ctx.agentTeams.remoteOverview(lead).messages.map(item => item.id)).toEqual([sent.messageId, reply.messageId])
  expect(ctx.agentTeams.remoteOverview(peer).messages.map(item => item.id)).toEqual([sent.messageId, reply.messageId])
  expect(ctx.agentTeams.remoteOverview(foreign).messages).toEqual([])
  const otherPeer = (await ctx.agents.create({ sessionId: SessionId('other-peer'), meta: { cwd }, agentOptions: {} })).agent
  await workspace.attachSession(otherPeer.id)
  await ctx.agentTeams.sendMessage(peer, {
    ...message, target: workspacePeerName(otherPeer.id), content: [{ type: 'text', text: 'Separate review conversation.' }],
  })
  expect(ctx.agentTeams.remoteOverview(lead).messages.map(item => item.id)).toEqual([sent.messageId, reply.messageId])
  await workspace.detachSession(otherPeer.id)
  const controller = new AbortController()
  controller.abort(new Error('Overview cancelled'))
  expect(() => ctx.agentTeams.remoteOverview(lead, controller.signal)).toThrow('Overview cancelled')
  await expect(ctx.agentTeams.sendMessage(foreign, message)).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
  const detached = ctx.agentTeams.waitForChange(lead, 10_000, signal)
  await workspace.detachSession(peer.id)
  expect(await detached).toEqual({ timedOut: false })
  expect(ctx.agentTeams.listMembers(lead).map(member => member.id)).toEqual([lead.id])
  expect(ctx.agentTeams.workspaceTasks(lead)).toEqual([])
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
      expect.objectContaining({ id: reply.messageId, delivered: true }),
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
