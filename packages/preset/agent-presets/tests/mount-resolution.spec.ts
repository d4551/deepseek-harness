import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { mountPreset, PresetMountError } from '../src/index.ts'
import { afterEach, expect, it } from 'vitest'

const execute = promisify(execFile)
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('rejects a missing host base before starting a preset subtree', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader)
  const scoped = createScope(ctx, {})
  const lifetimes = [...ctx.registry.lifetimes]
  try {
    await expect(mountPreset(scoped.ctx, {
      id: 'baseless', trust: 'user', path: join(import.meta.dirname, 'fixtures/system/standard/agent.cordis.yml'),
    })).rejects.toThrow(new PresetMountError('baseless', 'mounting needs `ctx.baseUrl` to resolve packages from the host composition'))
    expect([...ctx.registry.lifetimes]).toEqual(lifetimes)
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([true, false])('resolves preset packages from the host with native addons enabled: %s', async (addons) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-preset-resolution-'))
  directories.push(root)
  const host = join(root, 'host')
  const preset = join(root, 'preset')
  const moduleName = 'preset-resolution-provider'
  const locations: Array<[string, string]> = [[host, 'host'], [preset, 'preset']]
  for (const [directory, label] of locations) {
    const installed = join(directory, 'node_modules', moduleName)
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: moduleName, type: 'module', exports: './index.mjs' }))
    writeFileSync(join(installed, 'index.mjs'), `export function apply(ctx) { ctx.provide('presetResolutionMarker', ${JSON.stringify(label)}) }\n`)
  }
  const packageConfig = join(preset, 'package.json')
  const baseUrl = pathToFileURL(join(host, 'entry.mjs')).href
  const packageRows: EntryOptions[] = [
    { id: 'package', name: moduleName, isolate: { presetResolutionMarker: true } },
  ]
  writeFileSync(packageConfig, JSON.stringify(packageRows))
  const plugin = join(preset, 'plugin.mjs')
  writeFileSync(plugin, 'export function apply(ctx, config) { ctx.provide("presetResolutionMarker", config.label) }\n')
  const filesConfig = join(preset, 'files.json')
  const fileRows: EntryOptions[] = [
    { id: 'absolute', name: plugin, config: { label: 'absolute' }, isolate: { presetResolutionMarker: true } },
    { id: 'url', name: pathToFileURL(plugin).href, config: { label: 'url' }, isolate: { presetResolutionMarker: true } },
    { id: 'relative', name: './plugin.mjs', config: { label: 'relative' }, isolate: { presetResolutionMarker: true } },
    { id: 'builtin', name: 'cordis:group', config: [] },
  ]
  writeFileSync(filesConfig, JSON.stringify(fileRows))
  const script = `
    import assert from 'node:assert/strict'
    import { Context } from '@deepseek-ai/cordis'
    import Loader from '@deepseek-ai/cordis-plugin-loader'
    import Group from '@deepseek-ai/cordis-plugin-group'
    import { createScope } from '@deepseek-ai/dsh-scope'
    import { mountPreset, livePresetMounts, PresetMountError } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)}
    const ctx = new Context()
    ctx.baseUrl = ${JSON.stringify(baseUrl)}
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    const key = {}
    const scoped = createScope(ctx, key)
    try {
      const descriptor = { id: 'package-resolution', trust: 'user', path: ${JSON.stringify(packageConfig)} }
      if (${addons}) {
        assert.ok(ctx.loader.internal)
        await mountPreset(scoped.ctx, descriptor)
        const mounted = livePresetMounts().find(mount => mount.key === key)
        assert.ok(mounted)
        const entry = mounted.tree.resolve('package')
        assert.ok(entry.fiber)
        assert.equal(entry.fiber.ctx.get('presetResolutionMarker'), 'host')
      } else {
        assert.equal(ctx.loader.internal, undefined)
        const lifetimes = [...ctx.registry.lifetimes]
        await assert.rejects(mountPreset(scoped.ctx, descriptor), error => {
          assert.ok(error instanceof PresetMountError)
          assert.ok(error.message.includes(${JSON.stringify(`cannot resolve preset plugin "${moduleName}" from ${baseUrl}: native module loader is unavailable`)}))
          return true
        })
        assert.deepEqual([...ctx.registry.lifetimes], lifetimes)
        assert.equal(livePresetMounts().some(mount => mount.key === key), false)
      }
      const filesKey = {}
      const filesScope = createScope(ctx, filesKey)
      await mountPreset(filesScope.ctx, { id: 'file-resolution', trust: 'user', path: ${JSON.stringify(filesConfig)} })
      const filesMount = livePresetMounts().find(mount => mount.key === filesKey)
      assert.ok(filesMount)
      for (const id of ['absolute', 'url', 'relative']) {
        const entry = filesMount.tree.resolve(id)
        assert.ok(entry.fiber)
        assert.equal(entry.fiber.ctx.get('presetResolutionMarker'), id)
      }
      assert.ok(filesMount.tree.resolve('builtin').fiber)
      assert.equal(ctx.get('presetResolutionMarker'), undefined)
      await filesScope.dispose()
      assert.equal(livePresetMounts().some(mount => mount.key === filesKey), false)
    } finally {
      await ctx.fiber.dispose()
    }
    assert.equal(livePresetMounts().some(mount => mount.key === key), false)
    console.log('preset resolution verified')
  `
  const args = ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script]
  if (!addons) args.unshift('--no-addons')
  const result = await execute(process.execPath, args)
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('preset resolution verified\n')
})
