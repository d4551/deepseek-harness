// Boots the shipped `swarm-web` profile template — every bundle its
// PROFILE_TEMPLATES tuple names, resolved to the layer files those packages
// publish — and asserts what that composition produces: the swarm bounds and
// the swarm policy the model reads, plus the browser rows the roster serves.
//
// No browser and no model call. The rendered Agent Team panel already has a
// browser case (agent-team-panel.e2e.ts) and the workspace-roots header has
// its own (workspace-management.e2e.ts); neither runs the shipped `swarm-web`
// layers, and neither would notice the swarm deltas — coordination, roster
// ceiling, run ceiling — because those reach the model, not the DOM. This is
// the boundary that holds them.
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { composeEntries, loadOverlayPatches, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
// Empty type imports carry the agents/subagents/agentTeams/systemPrompt/clientModules Context merges.
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

/** The template under test: the profile that makes swarm mode reachable from a browser. */
const TEMPLATE_NAME = 'swarm-web'

/**
 * The two layers the scaffold already boots as the shipped Web surface. The
 * template must open with exactly this pair, or the layers below would stack on
 * a surface the profile does not ship.
 */
const SCAFFOLD_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Client packages the roster must serve for the swarm surface to be usable. */
const REQUIRED_CLIENT_ROWS = [
  '@deepseek-ai/dsh-client-ui-agent-team',
  '@deepseek-ai/dsh-client-ui-workspace-roots',
]

/** The `dsh` manifest slice a bundle package publishes. */
interface BundleManifest {
  name?: string
  dsh?: { bundle?: { patch?: string } }
}

/**
 * Index every workspace package directory by its published name.
 * @returns Package name to absolute package directory.
 */
function workspacePackageDirs(): Map<string, string> {
  const root = join(REPO_ROOT, 'packages')
  const dirs = new Map<string, string>()
  for (const group of readdirSync(root, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(root, group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const dir = join(root, group.name, pkg.name)
      let manifest: BundleManifest
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as BundleManifest
      } catch {
        // A directory with no readable manifest is not a workspace package.
        continue
      }
      if (typeof manifest.name === 'string') dirs.set(manifest.name, dir)
    }
  }
  return dirs
}

/**
 * Resolve one template bundle to the patch file its own manifest publishes.
 * @param packageName - Bundle package name from the profile template.
 * @param dirs - Workspace package index.
 * @returns Absolute path of the bundle's declared patch layer.
 */
function bundlePatchPath(packageName: string, dirs: Map<string, string>): string {
  const dir = dirs.get(packageName)
  expect(dir, `${TEMPLATE_NAME} names bundle ${packageName}, which this checkout does not publish`)
    .toBeTypeOf('string')
  const manifest = JSON.parse(readFileSync(join(dir!, 'package.json'), 'utf8')) as BundleManifest
  const declared = manifest.dsh?.bundle?.patch
  expect(declared, `${packageName} must declare dsh.bundle.patch to be a profile bundle`).toBeTypeOf('string')
  return join(dir!, declared!)
}

/**
 * Read one composed row's config.
 * @param rows - Composed entry list.
 * @param id - Row id.
 * @returns The row's config fields.
 */
function rowConfig(rows: readonly EntryOptions[], id: string): Record<string, unknown> {
  const row = rows.find(entry => entry.id === id)
  expect(row, `the composed ${TEMPLATE_NAME} tree must carry row ${id}`).toBeDefined()
  return (row?.config ?? {}) as Record<string, unknown>
}

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('composes the shipped swarm-web template into the swarm bounds and browser rows', async () => {
  const template = PROFILE_TEMPLATES[TEMPLATE_NAME]
  expect(template, 'swarm-web must remain a shipped profile template').toBeDefined()
  expect(template?.patchReload).toBe('live')
  const bundles = [...template?.bundles ?? []]
  // The scaffold boots the first two layers itself. Pinning them keeps the
  // overlay substitution below honest: a template that swapped its surface
  // bundle would fail here instead of being silently tested on the old one.
  expect(bundles.slice(0, SCAFFOLD_BUNDLES.length)).toEqual(SCAFFOLD_BUNDLES)
  expect(bundles.length).toBeGreaterThan(SCAFFOLD_BUNDLES.length)

  const dirs = workspacePackageDirs()
  const patchPaths = bundles.map(packageName => bundlePatchPath(packageName, dirs))
  const composed = composeEntries(patchPaths.map(path => loadOverlayPatches(TEMPLATE_NAME, path)))

  // The effective entry list the launcher would mount: the swarm deltas that
  // distinguish this template from the delegated Agent Teams layer.
  expect(rowConfig(composed, 'subagent').maxConcurrentRuns).toBe(8)
  expect(rowConfig(composed, 'agent-team').maxMembers).toBe(16)
  expect(rowConfig(composed, 'tool-agent-team').coordination).toBe('swarm')
  const composedNames = composed.map(entry => entry.name)
  for (const row of REQUIRED_CLIENT_ROWS) expect(composedNames).toContain(row)

  // Boot the remaining layers over the scaffold's shipped base and Web surface,
  // in the template's own order, from the same files the launcher would read.
  const overlays = patchPaths.slice(SCAFFOLD_BUNDLES.length)
  scaffold = await launchWebScaffold({
    extraOverlayPath: overlays,
    extraInstallAnchors: bundles.slice(SCAFFOLD_BUNDLES.length)
      .map(packageName => join(dirs.get(packageName)!, 'package.json')),
  })
  const ctx = scaffold.ctx

  // The live Loader must carry the same values, not merely the composed document.
  const bootedConfig = (id: string): Record<string, unknown> => {
    const entry = [...ctx.loader.entries()].find(row => row.options.id === id)
    expect(entry, `the booted ${TEMPLATE_NAME} tree must carry row ${id}`).toBeDefined()
    return (entry?.options.config ?? {}) as Record<string, unknown>
  }
  expect(bootedConfig('subagent').maxConcurrentRuns).toBe(8)
  expect(bootedConfig('agent-team').maxMembers).toBe(16)
  expect(bootedConfig('tool-agent-team').coordination).toBe('swarm')

  // The run ceiling is realized by the seam, not just declared in a row.
  expect(ctx.subagents.capacity()).toEqual({ limit: 8, active: 0, waiting: 0 })

  // The browser roster the Host serves: both rows resolved to real client bundles.
  const clientRows = ctx.clientModules.graph().entries.map(entry => entry.id)
  for (const row of REQUIRED_CLIENT_ROWS) expect(clientRows).toContain(row)

  // What the swarm composition puts in front of the model. `coordination: swarm`
  // selects a different policy than the delegated layer any other test exercises,
  // and the Team tools register in the Agent's own scope.
  const handle = await ctx.agents.create({
    sessionId: SessionId('swarm-web-composition'),
    meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    expect(ctx.agentTeams.membership(handle.agent).role).toBe('lead')
    const assembled = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    expect(assembled.tools.map(schema => schema.name)).toContain('team_task_claim_next')
    const prompt = renderPrompt(assembled)
    expect(prompt).toContain('This session runs as a swarm')
    expect(prompt).toContain('Do not name a specific task in a teammate\'s prompt')
    expect(prompt).not.toContain('create teammates only when the user explicitly asks')
  } finally {
    await handle.dispose()
  }
}, 180_000)
