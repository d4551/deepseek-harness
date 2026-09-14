import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
  await symlink(join(FIXTURES, 'plugins'), join(generation, 'source', 'plugins'))
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

it('mounts published runtime plugins and nested compositions beside a linked generation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-preset-generation-'))
  await using cleanup = new AsyncDisposableStack()
  cleanup.defer(() => rm(home, { recursive: true }))
  const generation = join(home, 'generations', 'release')
  const preset = join(generation, 'preset')
  const runtime = join(generation, 'runtime')
  const root = join(home, '.agent-presets')
  await mkdir(preset, { recursive: true })
  await mkdir(runtime)
  await mkdir(root)
  await mkdir(join(home, 'runtime'))
  await symlink('generations/release', join(home, 'current'))
  await symlink('../current/preset', join(root, 'deployment'))
  await symlink('../current/runtime', join(home, 'runtime', 'dsh'))
  await copyFile(join(FIXTURES, 'plugins', 'contribute.js'), join(runtime, 'contribute.mjs'))
  await copyFile(join(FIXTURES, 'plugins', 'contribute.js'), join(preset, 'local.mjs'))
  await writeFile(join(preset, 'agent.cordis.yml'), [
    '- id: local',
    '  name: ./local.mjs',
    '  config: { tool: local }',
    '- id: runtime',
    '  name: ../../runtime/dsh/contribute.mjs',
    '  config: { tool: runtime }',
    '- id: nested',
    '  name: cordis:include',
    '  config: { path: ../../runtime/dsh/nested.cordis.yml }',
    '',
  ].join('\n'))
  await writeFile(join(runtime, 'nested.cordis.yml'), [
    '- id: nested-tool',
    '  name: ./contribute.mjs',
    '  config: { tool: nested }',
    '',
  ].join('\n'))
  const ctx = await harness({
    default: 'deployment',
    roots: [{ path: root, trust: 'system' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  cleanup.defer(() => ctx.fiber.dispose())
  const presets = await ctx.agentPresets.list()
  expect(presets.map(value => value.broken)).toEqual([undefined])
  expect(presets.map(value => value.path)).toEqual([join(root, 'deployment', 'agent.cordis.yml')])
  const agent = await agentOn(ctx, 'generation-session', 'deployment')
  expect(toolNames(ctx, agent)).toEqual(['local', 'nested', 'runtime'])
  expect(toolNames(ctx)).toEqual([])
})
