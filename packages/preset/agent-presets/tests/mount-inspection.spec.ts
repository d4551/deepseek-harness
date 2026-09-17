import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { expect, it, onTestFinished } from 'vitest'
import { inactiveRows, livePresetMounts, mountPreset, serviceForAgent } from '../src/mount.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    presetInspectionValue: { readonly label: string }
  }
}

it('does not expose host services to an agent without a standing composition', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  const standalone = createScope(ctx, {})
  const unmounted = createScope(ctx, {}, { parent: {} })

  expect(ctx.get('loader')).toBeDefined()
  expect(serviceForAgent(ctx, { ctx }, 'loader')).toBeUndefined()
  expect(serviceForAgent(ctx, standalone, 'loader')).toBeUndefined()
  expect(serviceForAgent(ctx, unmounted, 'loader')).toBeUndefined()
})

it('reports an enabled Loader entry after its runtime has been released', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  ctx.loader.builtins.value = (pluginCtx: Context) => {
    pluginCtx.provide('presetInspectionValue', { label: 'entry-owned' })
  }
  await ctx.loader.root.update([{ id: 'released', name: 'cordis:value' }])
  expect(inactiveRows(ctx.loader)).toEqual([])
  expect(ctx.get('presetInspectionValue')).toEqual({ label: 'entry-owned' })

  const entry = ctx.loader.resolve('released')
  await entry._dispose()

  expect(entry.disabled).toBe(false)
  expect(entry.fiber).toBeUndefined()
  expect(ctx.get('presetInspectionValue')).toBeUndefined()
  expect(inactiveRows(ctx.loader)).toEqual(['released (cordis:value): never started'])
})

it('reads only the requested service from the joined isolated composition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-inspection-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'agent.cordis.json')
  await writeFile(path, JSON.stringify([{
    id: 'realm', name: 'cordis:group', group: true,
    isolate: { presetInspectionValue: true },
    config: [{ id: 'value', name: 'cordis:value' }],
  }]))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.value = (pluginCtx: Context) => {
    pluginCtx.provide('presetInspectionValue', { label: 'preset-owned' })
  }
  const standingKey = {}
  const standing = createScope(ctx, standingKey)
  await mountPreset(standing.ctx, { id: 'isolated', trust: 'user', path })
  const agent = createScope(ctx, {}, { parent: standingKey })

  expect(ctx.get('presetInspectionValue')).toBeUndefined()
  expect(serviceForAgent(ctx, agent, 'presetInspectionValue')).toEqual({ label: 'preset-owned' })
  expect(serviceForAgent(ctx, agent, 'loader')).toBeUndefined()

  const mount = livePresetMounts().find(candidate => candidate.key === standingKey)
  if (mount === undefined) throw new Error('standing composition was not registered')
  const disposal = mount.fiber.dispose()
  expect(livePresetMounts().some(mount => mount.key === standingKey)).toBe(false)
  expect(serviceForAgent(ctx, agent, 'presetInspectionValue')).toBeUndefined()
  await disposal
})
