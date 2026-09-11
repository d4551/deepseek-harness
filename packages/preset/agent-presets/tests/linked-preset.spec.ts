import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentOn, FIXTURES, harness, toolNames } from './harness.ts'

it('mounts relative plugins through a registry link with the registered preset identity', async () => {
  const generation = await mkdtemp(join(tmpdir(), 'dsh-linked-mount-'))
  await using cleanup = new AsyncDisposableStack()
  cleanup.defer(() => rm(generation, { recursive: true }))
  const root = join(generation, 'source', 'agent-presets')
  await mkdir(root, { recursive: true })
  await mkdir(join(generation, 'runtime'))
  await symlink(join(FIXTURES, 'system', 'standard'), join(root, 'deployment'))
  const ctx = await harness({
    default: 'deployment',
    roots: [{ path: root, trust: 'system' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  cleanup.defer(() => ctx.fiber.dispose())
  const presets = await ctx.agentPresets.list()
  expect(presets.map(preset => preset.id)).toEqual(['deployment'])
  expect(presets.map(preset => preset.broken)).toEqual([undefined])
  const agent = await agentOn(ctx, 'linked-session', 'deployment')
  expect(toolNames(ctx, agent)).toEqual(['alpha'])
  expect(toolNames(ctx)).toEqual([])
})
