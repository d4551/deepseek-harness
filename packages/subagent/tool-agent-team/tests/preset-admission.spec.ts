import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { expect, it, onTestFinished } from 'vitest'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

const TEAM_TOOLS = [
  'followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_teammate',
  'team_task_claim_next', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'wait_agent',
]

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-preset-admission-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  for (const id of ['enabled', 'excluded']) {
    const directory = join(root, 'presets', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'agent.cordis.yml'), '[]\n')
  }
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(TeamService)
  await ctx.plugin(AgentPresets, {
    default: 'enabled',
    roots: [{ path: join(root, 'presets'), trust: 'user' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  const plugin = await ctx.plugin(toolTeam, { excludePresets: ['excluded'] })
  return { ctx, plugin }
}

it.each([
  { composed: 'excluded', recorded: undefined, expected: [] },
  { composed: 'excluded', recorded: 'enabled', expected: [] },
  { composed: 'enabled', recorded: 'excluded', expected: TEAM_TOOLS },
])('uses the live $composed composition with header $recorded', async ({ composed, recorded, expected }) => {
  const { ctx } = await setup()
  const handle = await ctx.agents.create({
    sessionId: SessionId('live-composition'),
    ...recorded === undefined ? {} : { meta: { agentPreset: recorded } },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, composed) },
  })
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()).toEqual(expected)
  const assembled = await ctx.systemPrompt.assemble({ scope: handle.agent })
  expect(assembled.sections.some(section => section.name === 'team:policy')).toBe(expected.length > 0)
})

it('denies an uncomposed Agent and admits it only after an enabled composition is joined', async () => {
  const { ctx } = await setup()
  const handle = await ctx.agents.create({ sessionId: SessionId('awaiting-composition') })
  expect(ctx.tools.schemas(handle.agent)).toEqual([])
  await ctx.agentPresets.recompose(handle.agent.ctx, 'enabled')
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()).toEqual(TEAM_TOOLS)
})

it('reconciles repeated switches and plugin disposal without duplicate or retained registrations', async () => {
  const { ctx, plugin } = await setup()
  const handle = await ctx.agents.create({
    sessionId: SessionId('switching-composition'),
    meta: { agentPreset: 'enabled' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'enabled') },
  })
  for (const selected of ['excluded', 'enabled', 'excluded', 'enabled']) {
    await ctx.agentPresets.recompose(handle.agent.ctx, selected)
    expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort())
      .toEqual(selected === 'enabled' ? TEAM_TOOLS : [])
    const assembled = await ctx.systemPrompt.assemble({ scope: handle.agent })
    expect(assembled.sections.filter(section => section.name === 'team:policy'))
      .toHaveLength(selected === 'enabled' ? 1 : 0)
  }
  await plugin.dispose()
  expect(ctx.tools.schemas(handle.agent)).toEqual([])
  const replacement = await ctx.plugin(toolTeam, { excludePresets: ['excluded'] })
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()).toEqual(TEAM_TOOLS)
  await handle.dispose()
  expect(ctx.tools.schemas(handle.agent)).toEqual([])
  await replacement.dispose()
})

it('denies a prepared Team call when its composition changes before dispatch', async () => {
  const { ctx } = await setup()
  const handle = await ctx.agents.create({
    sessionId: SessionId('prepared-team-call'),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'enabled') },
  })
  const entered = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<boolean>()
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.name === 'team_task_create') {
      entered.resolve(true)
      await release.promise
    }
    return next()
  })
  const pending = ctx.tools.execute({
    callId: ToolCallId('prepared-team-call'),
    name: 'team_task_create',
    arguments: { subject: 'Denied task', description: 'Must not reach the task board' },
    signal: new AbortController().signal,
    agent: handle.agent,
  })
  onTestFinished(async () => {
    release.resolve(true)
    await pending
  })
  await entered.promise
  await ctx.agentPresets.recompose(handle.agent.ctx, 'excluded')
  release.resolve(true)
  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.content).toEqual([{ type: 'text', text: 'Error: unknown tool "team_task_create"' }])
  expect(ctx.agentTeams.listTasks(handle.agent)).toEqual([])
})

it('rejects invalid coordination from an untyped direct plugin caller', async () => {
  const { ctx, plugin } = await setup()
  await ctx.agents.create({
    sessionId: SessionId('invalid-direct-coordination'),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'enabled') },
  })
  await plugin.dispose()
  expect(() => { Reflect.apply(toolTeam.apply, undefined, [ctx, { coordination: 'invalid' }]) })
    .toThrow('team coordination mode')
})

it('rejects a direct tool implementation call without its Agent identity', async () => {
  const { ctx } = await setup()
  const handle = await ctx.agents.create({
    sessionId: SessionId('missing-direct-caller'),
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'enabled') },
  })
  const tool = ctx.tools.get('list_agents', handle.agent)
  if (tool === undefined) throw new Error('Team roster tool is not registered')
  await expect(Reflect.apply(tool.execute.bind(tool), undefined, [{}, {}]))
    .rejects.toThrow('list_agents requires a calling Agent')
})
