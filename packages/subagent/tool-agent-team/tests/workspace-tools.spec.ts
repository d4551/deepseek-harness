import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import SubagentService from '@deepseek-ai/dsh-subagent'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function setupWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-team-tools-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionQuery, { path: join(root, 'query.sqlite') })
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 80, maxTitleBytes: 200 })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(['hang']))
  await ctx.plugin(SubagentService)
  await ctx.plugin(TeamService)
  await ctx.plugin(toolTeam)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'workspaces.sqlite') })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await ctx.plugin(WorkspaceRegistry)
  const workspace = await ctx.workspaceRegistry.create(cwd)
  const lead = (await ctx.agents.create({ sessionId: SessionId('reader'), meta: { cwd }, agentOptions: {} })).agent
  const peer = (await ctx.agents.create({
    sessionId: SessionId('writer'), meta: { cwd }, agentOptions: { provider: 'mock', model: 'mock' },
  })).agent
  await workspace.attachSession(lead.id)
  await workspace.attachSession(peer.id)
  let callNumber = 0
  const execute = (name: string, args: Record<string, unknown> = {}) => ctx.tools.execute({
    callId: ToolCallId(`workspace-call-${++callNumber}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: lead,
  })
  return { ctx, lead, peer, workspace, execute }
}

it('returns complete strict roster results for untitled, titled, and renamed workspace peers', async () => {
  const { ctx, lead, peer, execute } = await setupWorkspace()
  const untitled = await execute('list_agents')
  expect(untitled.isError).toBe(false)
  expect(untitled.content).toEqual([{ type: 'text', text: JSON.stringify(ctx.agentTeams.listMembers(lead)) }])
  expect(ctx.agentTeams.listMembers(lead)[1]).not.toHaveProperty('title')
  peer.session.append('request/header', {
    reason: 'initial', header: { config: { provider: 'selected', model: 'peer-selected-model' } },
  })
  for (const title of ['Workspace review', 'Renamed workspace review']) {
    ctx.sessionTitle.rename(peer.session, title)
    const result = await execute('list_agents')
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(ctx.agentTeams.listMembers(lead)) }])
    expect(ctx.agentTeams.listMembers(lead)[1]).toEqual({
      id: peer.id,
      name: `session:${peer.id}`,
      title,
      role: 'peer',
      status: 'idle',
      model: 'peer-selected-model',
      diagnostics: [],
    })
  }
})

it('waits for actual workspace write blockers while unrelated running peers cannot admit a wait', async () => {
  const { ctx, lead, peer, execute } = await setupWorkspace()
  peer.followup(createUserMessage({ content: [{ type: 'text', text: 'Keep working' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(peer.status).toBe('running') })
  const local = await ctx.agentTeams.createTask(lead, {
    subject: 'Shared file', description: 'Update only after the active writer finishes', writeScopes: ['src/shared.ts'],
  })
  const unrelated = await execute('wait_agent', { timeout_ms: 10_000 })
  expect(unrelated.isError).toBe(false)
  expect(JSON.parse(unrelated.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')))
    .toMatchObject({ timedOut: false, noProgress: { reason: 'no-active-peer' } })
  const remote = await ctx.agentTeams.createTask(peer, {
    subject: 'Active writer', description: 'Finish the shared implementation', writeScopes: ['src'],
  })
  const claimed = await ctx.agentTeams.claimNextReadyTask(peer)
  expect(claimed.outcome).toBe('claimed')
  const changes = ctx.agentTeams.changes(peer, new AbortController().signal)[Symbol.asyncIterator]()
  await changes.next()
  const entered = changes.next()
  const waiting = execute('wait_agent', { timeout_ms: 10_000 })
  await expect(entered).resolves.toMatchObject({ done: false })
  expect(ctx.agentTeams.listMembers(peer)[1]?.status).toBe('waiting')
  const committed = changes.next()
  const completed = await ctx.agentTeams.updateTask(peer, {
    taskId: remote.id, expectedRevision: 2, action: 'complete',
  })
  expect(completed.status).toBe('completed')
  const commitRevision = await committed
  const result = await waiting
  expect(result.isError).toBe(false)
  const value: unknown = JSON.parse(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
  expect(value).toMatchObject({ timedOut: false })
  expect(value).toHaveProperty('cursor', expect.any(String))
  expect(value).not.toHaveProperty('noProgress')
  const exitRevision = await changes.next()
  expect(exitRevision.done).toBe(false)
  if (exitRevision.done || commitRevision.done) throw new Error('workspace activity stream ended before wait settlement')
  expect(exitRevision.value).toBeGreaterThan(commitRevision.value)
  expect(ctx.agentTeams.listMembers(peer)[1]?.status).toBe('idle')
  expect(ctx.agentTeams.getTask(lead, local.id).writeScopeWarnings).toEqual([])
  await changes.return?.()
})

it('keeps the policy prefix stable while typed task reads retain complete local and workspace boards', async () => {
  const { ctx, lead, peer, workspace, execute } = await setupWorkspace()
  const scope = scopeOf(lead.ctx)
  if (scope === undefined) throw new Error('lead scope is required')
  const before = renderPrompt(await ctx.systemPrompt.assemble({ scope }))
  const description = 'Complete acceptance criteria and implementation evidence. '.repeat(100)
  const local = await ctx.agentTeams.createTask(lead, { subject: 'Local task', description })
  const remote = await ctx.agentTeams.createTask(peer, { subject: 'Peer task', description })
  await ctx.agentTeams.claimNextReadyTask(peer)
  const completed = await ctx.agentTeams.updateTask(peer, { taskId: remote.id, expectedRevision: 2, action: 'complete' })
  ctx.sessionTitle.rename(peer.session, 'Changed title')
  expect(renderPrompt(await ctx.systemPrompt.assemble({ scope }))).toBe(before)
  const localRead = await execute('team_task_get', { task_id: local.id })
  expect(localRead.isError).toBe(false)
  expect(localRead.content).toEqual([{ type: 'text', text: JSON.stringify(local) }])
  const peerRead = await execute('team_task_get', { task_id: remote.id, session_id: peer.id })
  expect(peerRead.isError).toBe(false)
  expect(peerRead.content).toEqual([{ type: 'text', text: JSON.stringify(completed) }])
  const peerList = await execute('team_task_list', { session_id: peer.id, status: 'completed', limit: 1 })
  expect(peerList.isError).toBe(false)
  expect(peerList.content).toEqual([{ type: 'text', text: JSON.stringify({ tasks: [completed] }) }])
  await workspace.detachSession(peer.id)
  for (const name of ['team_task_list', 'team_task_get']) {
    const denied = await execute(name, { task_id: remote.id, session_id: peer.id })
    expect(denied.isError).toBe(true)
    expect(denied.error?.info?.code).toBe('TEAM_MEMBER_NOT_FOUND')
  }
})
