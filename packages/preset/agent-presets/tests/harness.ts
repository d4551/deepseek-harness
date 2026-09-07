/**
 * The composition and agent helpers the agent-presets suites share: the
 * registries a preset contributes to, the roster over the fixture roots, and
 * one agent joined to a preset through the factory's setup hook.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'

/** The fixture presets and plugins beside the suites. */
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** The fixture roots, the system root first so it shadows a user duplicate. */
export const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]

/**
 * A composition carrying the registries a preset contributes to, plus the
 * preset roster.
 * @param roster - roster config, defaulting to the fixture roots.
 * @returns the booted context.
 */
export async function harness(roster: Config = { default: 'standard', roots: ROOTS, includeShippedRoot: false, includeUserRoot: false }): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // A preset outside this workspace cannot resolve `cordis-plugin-group` by
  // name, so the app registers it as a builtin; the fixtures compose the same
  // way real presets do, which needs it here too.
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  return ctx
}

/**
 * Create one agent joined to a preset, as the agent factory's setup hook does.
 * @param ctx - the booted composition.
 * @param id - the session id.
 * @param presetId - the preset to compose from; absent means the roster default.
 * @returns the published agent.
 */
export async function agentOn(ctx: Context, id: string, presetId?: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, presetId) },
  })
  return handle.agent
}

/**
 * The tool names one agent's composition exposes, sorted; the global layer when no agent is given.
 * @param ctx - the booted composition.
 * @param agent - the agent whose view to read.
 * @returns the sorted tool names.
 */
export const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()
