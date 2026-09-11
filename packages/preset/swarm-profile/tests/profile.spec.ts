/**
 * The shipped swarm layer must declare one parseable patch that retunes only
 * rows `dsh-base` mounts for every profile and, when those rows are booted
 * through the real Loader with its overrides, produce a working swarm: the
 * bounded subagent run ceiling, the wider Team roster, the pull-based claim
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

/** One patch row in a bundle document. */
interface PatchRow {
  id?: string
  name?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: PatchRow[]
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const basePatchPath = resolve(packageRoot, '..', '..', 'bundle', 'base', 'cordis.patch.yml')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  private?: boolean
  publishConfig?: { access?: string }
  dsh?: { bundle?: { patch?: string } }
}

/** The value each retuned row changes; every other key must restate `dsh-base`. */
const DOCUMENTED_DELTAS: Record<string, Record<string, unknown>> = {
  'subagent': { maxConcurrentRuns: 8 },
  'agent-team': { maxMembers: 16 },
  'tool-agent-team': { coordination: 'swarm' },
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

/** Every row `dsh-base` mounts, flattened out of its insert lists. */
function baseRows(): PatchRow[] {
  const base = yaml.load(readFileSync(basePatchPath, 'utf8'), { schema: entryListSchema }) as PatchRow[]
  return base.flatMap(row => [row, ...(row.insert ?? [])])
}

/** One base row with this layer's override applied, as a Loader entry. */
function retunedRow(patches: PatchRow[], id: string): { name: string; config?: Record<string, unknown> } {
  const row = baseRows().find(entry => entry.id === id)
  if (row?.name === undefined) throw new Error(`dsh-base must mount row ${id}`)
  const config = patches.find(patch => patch.id === id)?.config ?? row.config
  return { name: row.name, ...config === undefined ? {} : { config } }
}

/** Render the base rows this layer retunes, with its overrides, as one config document. */
function swarmComposition(patches: PatchRow[], storageRoot: string): string {
  const rows = [
    { name: '@deepseek-ai/dsh-llm' },
    { name: '@deepseek-ai/dsh-session' },
    { name: '@deepseek-ai/dsh-system-prompt' },
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-agent' },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: storageRoot } },
    { name: '@deepseek-ai/dsh-test-session-query' },
    { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    retunedRow(patches, 'subagent'),
    { name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
    { name: '@deepseek-ai/dsh-subagent-fork-in-process', config: { providerName: 'fork' } },
    retunedRow(patches, 'agent-team'),
    retunedRow(patches, 'tool-agent-team'),
  ]
  return yaml.dump(rows)
}

/** Boot one Loader composition over the retuned rows with no network or model access. */
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
  it('declares a publishable layer that retunes only rows dsh-base mounts', async () => {
    // The shipped `swarm` and `swarm-web` templates name this bundle, so a
    // release that omitted it would leave those profiles unable to resolve it.
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')

    const patches = await shippedPatch()
    // A patch whose target row is absent stays a Loader warning by design, so
    // a base row this layer no longer finds would silently leave the swarm
    // running on delegated defaults. Every row here must name a base row, and
    // the layer inserts, disables, and mounts nothing of its own.
    const baseIds = new Set(baseRows().map(row => row.id).filter((id): id is string => id !== undefined))
    expect(patches.map(row => row.id).sort()).toEqual(Object.keys(DOCUMENTED_DELTAS).sort())
    for (const row of patches) {
      expect(baseIds, row.id).toContain(row.id)
      expect(row.name, row.id).toBeUndefined()
      expect(row.insert, row.id).toBeUndefined()
      expect(row.disabled, row.id).toBeUndefined()
    }
  })

  it('changes exactly its documented values and restates every other key', async () => {
    // A patch replaces the targeted row's whole config, so a key this layer
    // forgot to restate would fall back to the plugin default rather than to
    // the value base composed. Each row is therefore compared to base's own.
    const patches = await shippedPatch()
    const base = baseRows()
    expect(base.find(row => row.id === 'tool-subagent')?.config).toEqual({
      provider: 'spawn', toolName: 'subagent', backgroundMode: 'one-shot',
    })
    for (const row of patches) {
      const composed = base.find(entry => entry.id === row.id)?.config ?? {}
      const retuned = row.config ?? {}
      const changed = Object.fromEntries(
        Object.entries(retuned).filter(([key, value]) => JSON.stringify(composed[key]) !== JSON.stringify(value)),
      )
      expect(changed, row.id).toEqual(DOCUMENTED_DELTAS[row.id ?? ''])
      expect(Object.keys(composed).filter(key => !(key in retuned)), row.id).toEqual([])
    }
  })

  it('boots its retuned rows into a bounded seam, the claim tool, and swarm guidance', async () => {
    const patches = await shippedPatch()
    root = await mkdtemp(join(tmpdir(), 'dsh-swarm-profile-'))
    const storageRoot = join(root, 'sessions')
    context = await boot(swarmComposition(patches, storageRoot), join(root, 'cordis.yml'), root)

    expect(context.subagents.capacity()).toEqual({ limit: 8, active: 0, waiting: 0 })

    const lead = context.agentLoop.create(SessionId('swarm-lead'), { provider: 'mock', model: 'mock' })
    expect(context.agentTeams.membership(lead).role).toBe('lead')
    const scope = scopeOf(lead.ctx)
    if (scope === undefined) throw new Error('expected an Agent scope for the Lead')
    const assembled = await context.systemPrompt.assemble({ scope })

    expect(assembled.tools.map(schema => schema.name)).toContain('team_task_claim_next')
    const prompt = renderPrompt(assembled)
    expect(prompt).toContain('This session runs as a swarm')
    expect(prompt).toContain('team_task_claim_next')
    expect(prompt).toContain('When the user assigns named teammates specific responsibilities, preserve those assignments')
    expect(prompt).toContain('Use team_task_claim_next for work without a named assignment')
    expect(prompt).not.toContain('create teammates only when the user explicitly asks')

    // The board is live in the booted composition, not merely registered.
    await expect(context.agentTeams.claimNextReadyTask(lead))
      .resolves.toEqual({ outcome: 'none', reason: 'no-pending-task', deferred: [] })
  })
})
