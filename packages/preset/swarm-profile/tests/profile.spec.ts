/**
 * The shipped swarm layer must declare one parseable patch and, when its own
 * rows are booted through the real Loader, produce a working swarm: the bounded
 * subagent run ceiling, the shared Team board including the pull-based claim
 * tool, and the swarm guidance in the assembled system prompt.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import TeamService from '@deepseek-ai/dsh-agent-team'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as ToolAgentTeam from '@deepseek-ai/dsh-tool-agent-team'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/** One patch row in the shipped bundle document. */
interface PatchRow {
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: { id?: string; name?: string; config?: Record<string, unknown> }[]
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  private?: boolean
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

/** Session query implementation whose search faces are outside this test. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Read the shipped patch document through the Loader's own entry schema. */
async function shippedPatch(): Promise<PatchRow[]> {
  const patchPath = manifest.dsh?.bundle?.patch
  if (patchPath === undefined) throw new Error('the swarm package must declare a Bundle patch')
  const parsed = yaml.load(
    await readFile(resolve(packageRoot, patchPath), 'utf8'),
    { schema: entryListSchema },
  )
  expect(Array.isArray(parsed)).toBe(true)
  return parsed as PatchRow[]
}

/** Render the shipped rows this layer inserts, plus its subagent bound, as one config document. */
function swarmComposition(patches: PatchRow[], storageRoot: string): string {
  const subagentConfig = patches.find(patch => patch.id === 'subagent')?.config
  if (subagentConfig === undefined) throw new Error('the swarm layer must bound the subagent seam')
  const inserted = patches.flatMap(patch => patch.insert ?? [])
  const rows = [
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-agent' },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: storageRoot } },
    { name: '@deepseek-ai/dsh-test-session-query' },
    { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    { name: '@deepseek-ai/dsh-subagent', config: subagentConfig },
    { name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
    { name: '@deepseek-ai/dsh-subagent-fork-in-process', config: { providerName: 'fork' } },
    ...inserted.map(entry => ({
      name: entry.name,
      ...entry.config === undefined ? {} : { config: entry.config },
    })),
  ]
  return yaml.dump(rows)
}

/** Boot one Loader composition over the shipped rows with no network or model access. */
async function boot(document: string, configPath: string, dir: string): Promise<Context> {
  await writeFile(configPath, document)
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(dir).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-test-session-query', TestSessionQuery],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-subagent', SubagentRuntime],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', SubagentSpawn],
    ['@deepseek-ai/dsh-subagent-fork-in-process', SubagentFork],
    ['@deepseek-ai/dsh-agent-team', TeamService],
    ['@deepseek-ai/dsh-tool-agent-team', ToolAgentTeam],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('swarm profile bundle', () => {
  it('declares a parseable layer that bounds subagent runs and inserts the Team stack', async () => {
    // The shipped `swarm` profile template names this bundle, so a release that
    // omitted it would leave `dsh --profile swarm` unable to resolve its layer.
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-agent-team': 'workspace:^',
      '@deepseek-ai/dsh-subagent': 'workspace:^',
      '@deepseek-ai/dsh-tool-agent-team': 'workspace:^',
    })

    const patches = await shippedPatch()
    expect(patches.find(patch => patch.id === 'subagent')?.config)
      .toMatchObject({ maxConcurrentRuns: expect.any(Number) as number })
    expect(patches.find(patch => patch.id === 'tool-subagent-control')).toMatchObject({ disabled: true })
    expect(patches.find(patch => patch.id === 'tool-subagent-list-agents')).toMatchObject({ disabled: true })
    expect(patches.find(patch => patch.id === 'tool-subagent-report')).toMatchObject({ disabled: true })
    const inserted = patches.flatMap(patch => patch.insert ?? [])
    expect(inserted.find(entry => entry.id === 'agent-team')?.name).toBe('@deepseek-ai/dsh-agent-team')
    expect(inserted.find(entry => entry.id === 'tool-agent-team')).toMatchObject({
      name: '@deepseek-ai/dsh-tool-agent-team',
      config: { coordination: 'swarm' },
    })
  })

  it('is the Agent Teams layer plus exactly its documented swarm deltas', async () => {
    // The two patch documents are near-identical YAML, and `bun run duplication`
    // scans TypeScript only, so nothing else would notice one drifting from the
    // other. A rename in base's subagent rows has to reach both files; this
    // fails when it reaches only one.
    const swarm = await shippedPatch()
    const team = yaml.load(
      await readFile(resolve(packageRoot, '..', 'agent-team-profile', 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    ) as PatchRow[]

    const deltas = swarm.filter(row => row.id === 'subagent')
    expect(deltas.map(row => row.config)).toEqual([{ maxConcurrentRuns: 8 }])

    // Everything else must be the team layer, with only the two documented
    // value changes: a wider roster and the swarm coordination mode.
    const rest = swarm.filter(row => row.id !== 'subagent')
    const teamAsSwarm = JSON.parse(JSON.stringify(team).replace('"maxMembers":8', '"maxMembers":16')) as PatchRow[]
    const withCoordination = JSON.parse(
      JSON.stringify(rest).replace(',"coordination":"swarm"', ''),
    ) as PatchRow[]
    expect(withCoordination).toEqual(teamAsSwarm)
  })

  it('targets only row ids the base bundle actually declares', async () => {
    // A patch whose target row is absent stays a Loader warning by design, so a
    // renamed base row would silently leave the global tools registered beside
    // the Team-scoped ones. Nothing but this check would report it.
    const base = yaml.load(
      readFileSync(
        resolve(packageRoot, '..', '..', 'bundle', 'base', 'cordis.patch.yml'),
        'utf8',
      ),
      { schema: entryListSchema },
    ) as { id?: string; insert?: { id?: string }[] }[]
    const baseIds = new Set(
      base.flatMap(row => [row.id, ...(row.insert ?? []).map(entry => entry.id)])
        .filter((id): id is string => id !== undefined),
    )
    const targeted = (await shippedPatch()).map(row => row.id).filter((id): id is string => id !== undefined)
    expect(targeted.length).toBeGreaterThan(0)
    for (const id of targeted) expect(baseIds, id).toContain(id)
  })

  it('boots its own rows into a bounded seam, the claim tool, and swarm guidance', async () => {
    const patches = await shippedPatch()
    root = await mkdtemp(join(tmpdir(), 'dsh-swarm-profile-'))
    const storageRoot = join(root, 'sessions')
    context = await boot(swarmComposition(patches, storageRoot), join(root, 'cordis.yml'), root)

    const configuredBound = patches.find(patch => patch.id === 'subagent')?.config?.maxConcurrentRuns
    expect(context.subagents.capacity())
      .toEqual({ limit: configuredBound, active: 0, waiting: 0 })

    const lead = context.agentLoop.create(SessionId('swarm-lead'), { provider: 'mock', model: 'mock' })
    expect(context.agentTeams.membership(lead).role).toBe('lead')
    const scope = scopeOf(lead.ctx)
    if (scope === undefined) throw new Error('expected an Agent scope for the Lead')
    const assembled = await context.systemPrompt.assemble({ scope })

    expect(assembled.tools.map(schema => schema.name)).toContain('team_task_claim_next')
    const prompt = renderPrompt(assembled)
    expect(prompt).toContain('This session runs as a swarm')
    expect(prompt).toContain('team_task_claim_next')
    expect(prompt).toContain('Do not name a specific task in a teammate\'s prompt')
    expect(prompt).not.toContain('create teammates only when the user explicitly asks')

    // The board is live in the booted composition, not merely registered.
    await expect(context.agentTeams.claimNextReadyTask(lead))
      .resolves.toEqual({ outcome: 'none', reason: 'no-ready-task', deferred: [] })
  })
})
