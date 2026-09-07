/**
 * Reclaiming superseded standing generations: a generation is disposed once a
 * newer one replaced it — or its preset was copied over or removed — and no
 * session runs on it anymore.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { COMPOSITION_FILE, livePresetMounts } from '@deepseek-ai/dsh-agent-presets'
import { describe, expect, it, vi } from 'vitest'
import { agentOn, FIXTURES, harness, toolNames } from './harness.ts'

/** One-row composition whose single tool is named `tool`. */
const rowFor = (tool: string): string =>
  `- id: only\n  name: ${join(FIXTURES, 'plugins', 'contribute.js')}\n  config:\n    tool: ${tool}\n`

/**
 * A roster over a temp root holding one editable preset per id, each with the
 * `before` tool. Ids are per test because `livePresetMounts()` is a
 * process-global registry.
 */
async function editable(...ids: [string, ...string[]]): Promise<{ scoped: Context; pathOf: (id: string) => string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-generations-'))
  for (const id of ids) {
    await mkdir(join(root, id))
    await writeFile(join(root, id, COMPOSITION_FILE), rowFor('before'))
  }
  const scoped = await harness({ default: ids[0], roots: [{ path: root, trust: 'user' }], includeShippedRoot: false, includeUserRoot: false })
  return { scoped, pathOf: id => join(root, id, COMPOSITION_FILE) }
}

/** The live generations of one preset. */
const mountsOf = (id: string) => livePresetMounts().filter(mount => mount.presetId === id)

describe('reclaiming superseded generations', () => {
  it('disposes a superseded generation once its last joined session ends', async () => {
    const { scoped, pathOf } = await editable('reclaimed')
    const first = await scoped.agents.create({
      sessionId: SessionId('gen-first'),
      setup: async (agentCtx: Context) => { await scoped.agentPresets.mount(agentCtx, 'reclaimed') },
    })
    await writeFile(pathOf('reclaimed'), rowFor('afterwards'))
    const second = await agentOn(scoped, 'gen-second', 'reclaimed')
    expect(mountsOf('reclaimed')).toHaveLength(2)
    expect(toolNames(scoped, first.agent)).toEqual(['before'])

    await first.dispose()

    // The generation the disposed session ran on is gone; the current one still serves.
    await vi.waitFor(() => { expect(mountsOf('reclaimed')).toHaveLength(1) })
    expect(toolNames(scoped, second)).toEqual(['afterwards'])
  })

  it('disposes a superseded generation nobody joined as soon as the next one mounts', async () => {
    const { scoped, pathOf } = await editable('cold')
    await scoped.agentPresets.standingKeyFor('cold')
    expect(mountsOf('cold')).toHaveLength(1)

    await writeFile(pathOf('cold'), rowFor('afterwards'))
    const key = await scoped.agentPresets.standingKeyFor('cold')

    await vi.waitFor(() => { expect(mountsOf('cold').map(mount => mount.key)).toEqual([key]) })
  })

  it('moves a session\'s join when it recomposes, reclaiming the generation it left', async () => {
    const { scoped, pathOf } = await editable('from', 'to')
    const agent = await agentOn(scoped, 'gen-switch', 'from')
    await writeFile(pathOf('from'), rowFor('afterwards'))
    // The next generation retires the joined one, which the session still holds.
    await scoped.agentPresets.standingKeyFor('from')
    expect(mountsOf('from')).toHaveLength(2)

    await scoped.agentPresets.recompose(agent.ctx, 'to')

    await vi.waitFor(() => { expect(mountsOf('from')).toHaveLength(1) })
    expect(toolNames(scoped, agent)).toEqual(['before'])
  })

  it('retires the generation of a removed preset once its session ends', async () => {
    const { scoped } = await editable('gone')
    const handle = await scoped.agents.create({
      sessionId: SessionId('gen-gone'),
      setup: async (agentCtx: Context) => { await scoped.agentPresets.mount(agentCtx, 'gone') },
    })

    await scoped.agentPresets.remove('gone')
    // The session keeps the generation it runs on until it ends.
    expect(mountsOf('gone')).toHaveLength(1)
    expect(toolNames(scoped, handle.agent)).toEqual(['before'])

    await handle.dispose()
    await vi.waitFor(() => { expect(mountsOf('gone')).toHaveLength(0) })
  })

  it('counts a child joined through its parent, so the parent leaving alone reclaims nothing', async () => {
    const { scoped, pathOf } = await editable('shared')
    const parent = await scoped.agents.create({
      sessionId: SessionId('gen-parent'),
      setup: async (agentCtx: Context) => { await scoped.agentPresets.mount(agentCtx, 'shared') },
    })
    const child = await scoped.agents.create({
      sessionId: SessionId('gen-child'),
      setup: (childCtx: Context) => { scoped.agentPresets.composeFrom(childCtx, parent.agent.ctx) },
    })
    await writeFile(pathOf('shared'), rowFor('afterwards'))
    await scoped.agentPresets.standingKeyFor('shared')

    await parent.dispose()

    expect(mountsOf('shared')).toHaveLength(2)
    expect(toolNames(scoped, child.agent)).toEqual(['before'])
    await child.dispose()
    await vi.waitFor(() => { expect(mountsOf('shared')).toHaveLength(1) })
  })
})
