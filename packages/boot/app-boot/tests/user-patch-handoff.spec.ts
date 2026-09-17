import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import Hmr from '@deepseek-ai/cordis-plugin-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, loadOptionalPatches, watchUserPatches } from '../src/index.ts'

const directories: string[] = []
const polling = { interval: 10, timeout: 10_000 }

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function start(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-patch-handoff-'))
  directories.push(directory)
  const filename = join(directory, 'cordis.patch.yml')
  const config = join(directory, 'cordis.yml')
  writeFileSync(join(directory, 'value.mjs'), [
    'export function apply(ctx, config) {',
    '  if (config.reject) throw new Error("rejected patch generation")',
    '  ctx.provide("handoffValue", config.value)',
    '}',
    '',
  ].join('\n'))
  writeFileSync(config, '- id: value\n  name: ./value.mjs\n  config:\n    value: base\n')
  writeFileSync(filename, source)
  const initialPatches = loadOptionalPatches('handoff', filename) ?? []
  const ctx = await boot('handoff', config, structuredClone(initialPatches))
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0, repairInterval: 0 })
  return { ctx, filename, initialPatches }
}

it.each(['changed', 'removed'])('reconciles a layer %s after boot and before native watch attachment', async (change) => {
  const { ctx, filename, initialPatches } = await start('- id: value\n  config:\n    value: boot\n')
  try {
    expect(ctx.get('handoffValue')).toBe('boot')
    if (change === 'removed') unlinkSync(filename)
    else writeFileSync(filename, '- id: value\n  config:\n    value: changed\n')
    const options = { binName: 'handoff', filename, initialPatches, repairInterval: 10 }
    const stop = await watchUserPatches(ctx, options)
    try {
      await expect.poll((): unknown => ctx.get('handoffValue'), polling).toBe(change === 'removed' ? 'base' : 'changed')
    } finally {
      await stop()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it('retains equal native expression provenance and composes the next generation once', async () => {
  const { ctx, filename, initialPatches } = await start('- id: value\n  config:\n    value: !!js 6 * 7\n')
  let compositions = 0
  try {
    expect(ctx.get('handoffValue')).toBe(42)
    expect(isDeepStrictEqual(loadOptionalPatches('handoff', filename), initialPatches)).toBe(true)
    const options = {
      binName: 'handoff', filename, initialPatches, repairInterval: 10,
      compose(patches: PatchOptions[]) {
        compositions += 1
        return patches
      },
    }
    const stop = await watchUserPatches(ctx, options)
    try {
      expect(compositions).toBe(0)
      writeFileSync(filename, '- id: value\n  config:\n    value: next\n')
      await expect.poll((): unknown => ctx.get('handoffValue'), polling).toBe('next')
      expect(compositions).toBe(1)
    } finally {
      await stop()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it('does not compose a changed layer when native watcher registration fails', async () => {
  const { ctx, filename, initialPatches } = await start('- id: value\n  config:\n    value: boot\n')
  const observations: string[] = []
  let compositions = 0
  try {
    const stopExisting = await ctx.hmr.registerConfig(filename, () => { observations.push(filename) })
    try {
      expect(observations).toContain(filename)
      writeFileSync(filename, '- id: value\n  config:\n    value: changed\n')
      const options = {
        binName: 'handoff', filename, initialPatches, repairInterval: 10,
        compose(patches: PatchOptions[]) {
          compositions += 1
          return patches
        },
      }
      await expect(watchUserPatches(ctx, options)).rejects.toThrow('already registered')
      expect(compositions).toBe(0)
      expect(ctx.get('handoffValue')).toBe('boot')
    } finally {
      await stopExisting()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reports a broken handoff generation once and preserves the committed tree through recovery', async () => {
  const { ctx, filename, initialPatches } = await start('- id: value\n  config:\n    value: boot\n')
  const failures: Error[] = []
  ctx.on('hmr/config-update-failed', (_filename, error) => { failures.push(error) })
  try {
    writeFileSync(filename, '- id: value\n  config:\n    reject: true\n')
    const options = { binName: 'handoff', filename, initialPatches, repairInterval: 10 }
    const stop = await watchUserPatches(ctx, options)
    try {
      await expect.poll(() => failures.length, polling).toBe(1)
      expect(ctx.get('handoffValue')).toBe('boot')
      expect(failures[0]?.message).toContain('rejected patch generation')
      writeFileSync(filename, '- id: value\n  config:\n    value: recovered\n')
      await expect.poll((): unknown => ctx.get('handoffValue'), polling).toBe('recovered')
      expect(failures).toHaveLength(1)
    } finally {
      await stop()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
