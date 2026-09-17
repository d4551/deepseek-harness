import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { expect, it, onTestFinished, vi } from 'vitest'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

const TEAM_TOOLS = [
  'followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_teammate',
  'team_task_claim_next', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'wait_agent',
]

it.each(['delegated', 'swarm'])('keeps %s Team contributions inside their composition across copies and scope switches', async (coordination) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-scoped-team-admission-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const presets = join(root, 'presets')
  const enabled = join(presets, 'enabled')
  const excluded = join(presets, 'excluded')
  await mkdir(enabled, { recursive: true })
  await mkdir(excluded)
  await writeFile(join(enabled, 'agent.cordis.yml'), JSON.stringify([
    { id: 'team-tools', name: 'cordis:team-tools', config: { coordination } },
  ]))
  await writeFile(join(excluded, 'agent.cordis.yml'), '[]\n')
  await cp(enabled, join(presets, 'copied'), { recursive: true })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins['team-tools'] = toolTeam
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(TeamService)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentPresets, {
    default: 'enabled',
    roots: [{ path: presets, trust: 'user' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  const outside = await ctx.agents.create({
    sessionId: SessionId('outside-team-composition'),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'excluded') },
  })
  const first = await ctx.agents.create({
    sessionId: SessionId('original-team-composition'),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'enabled') },
  })
  expect(ctx.tools.schemas(outside.agent)).toEqual([])
  expect(ctx.tools.schemas(first.agent).map(tool => tool.name).sort()).toEqual(TEAM_TOOLS)
  const copy = await ctx.agents.create({
    sessionId: SessionId('copied-team-composition'),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'copied') },
  })
  expect(ctx.tools.schemas(copy.agent).map(tool => tool.name).sort()).toEqual(TEAM_TOOLS)
  expect(ctx.tools.schemas(outside.agent)).toEqual([])
  if (coordination === 'swarm') {
    await vi.waitFor(() => {
      expect(ctx.commands.find(first.agent, 'swarm')).toBeDefined()
      expect(ctx.commands.find(copy.agent, 'swarm')).toBeDefined()
    })
  }
  for (const selected of ['copied', 'excluded', 'enabled', 'copied', 'excluded']) {
    await ctx.agentPresets.recompose(first.agent.ctx, selected)
    expect(ctx.tools.schemas(first.agent).map(tool => tool.name).sort())
      .toEqual(selected === 'excluded' ? [] : TEAM_TOOLS)
    const assembly = await ctx.systemPrompt.assemble({ scope: first.agent })
    expect(assembly.sections.filter(section => section.name === 'team:policy'))
      .toHaveLength(selected === 'excluded' ? 0 : 1)
    expect(ctx.tools.schemas(copy.agent).map(tool => tool.name).sort()).toEqual(TEAM_TOOLS)
    expect(ctx.tools.schemas(outside.agent)).toEqual([])
    expect(ctx.commands.list(outside.agent)).toEqual([])
    if (coordination === 'swarm' && selected !== 'excluded') {
      await vi.waitFor(() => { expect(ctx.commands.find(first.agent, 'swarm')).toBeDefined() })
    } else {
      expect(ctx.commands.list(first.agent)).toEqual([])
    }
    expect(ctx.commands.list(copy.agent)).toHaveLength(coordination === 'swarm' ? 1 : 0)
  }
  const denied = await ctx.tools.execute({
    callId: ToolCallId('outside-team-task'), name: 'team_task_create',
    arguments: { subject: 'Denied', description: 'No composition grant' },
    signal: new AbortController().signal, agent: outside.agent,
  })
  expect(denied.isError).toBe(true)
  expect(ctx.agentTeams.listTasks(outside.agent)).toEqual([])
})
