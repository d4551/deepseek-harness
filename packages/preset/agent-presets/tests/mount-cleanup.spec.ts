import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setImmediate } from 'node:timers/promises'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createScope } from '@deepseek-ai/dsh-scope'
import { livePresetMounts, mountPreset, PresetMountError } from '../src/index.ts'
import { expect, it, onTestFinished } from 'vitest'

it('removes a pending mount when the Loader service is absent', async () => {
  const script = `
    import assert from 'node:assert/strict'
    import { Context } from '@deepseek-ai/cordis'
    import Loader from '@deepseek-ai/cordis-plugin-loader'
    import { createScope } from '@deepseek-ai/dsh-scope'
    import { mountPreset, livePresetMounts } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)}
    const ctx = new Context()
    ctx.baseUrl = ${JSON.stringify(new URL('./', import.meta.url).href)}
    const key = {}
    const scoped = createScope(ctx, key)
    const lifetimes = [...ctx.registry.lifetimes]
    try {
      await assert.rejects(mountPreset(scoped.ctx, {
        id: 'without-loader', trust: 'user', path: ${JSON.stringify(join(import.meta.dirname, 'fixtures/system/standard/agent.cordis.yml'))},
      }), /mounted subtree did not publish its entry tree/)
      assert.equal(ctx.registry.lifetimes.size, lifetimes.length)
      for (const fiber of lifetimes) assert.equal(ctx.registry.lifetimes.has(fiber), true)
      await ctx.plugin(Loader)
      assert.equal(livePresetMounts().some(mount => mount.key === key), false)
    } finally {
      await ctx.fiber.dispose()
    }
    console.log('pending preset released')
  `
  const result = await promisify(execFile)(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script,
  ])
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('pending preset released\n')
})

it('retains nested and non-Error details supplied by a plugin aggregate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-details-'))
  const path = join(root, 'agent.cordis.json')
  await writeFile(path, JSON.stringify([{ id: 'failure', name: 'cordis:failure' }]))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.failure = function failure(): never {
    throw new AggregateError([
      new AggregateError([new Error('first failure'), 'second failure'], 'nested failures'),
      new Error('third failure'),
    ], 'child failures')
  }
  const key = {}
  const scoped = createScope(ctx, key)
  try {
    await expect(mountPreset(scoped.ctx, { id: 'details', trust: 'user', path }))
      .rejects.toThrow(new PresetMountError('details', [
        'failed to apply loader entry failure (cordis:failure): child failures',
        '- nested failures',
        '  - first failure',
        '  - second failure',
        `- third failure (${path})`,
      ].join('\n')))
    expect(livePresetMounts().some(mount => mount.key === key)).toBe(false)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('reports every inactive row and every missing dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-inactive-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'agent.cordis.json')
  await writeFile(path, JSON.stringify([
    { id: 'first', name: 'cordis:missing' },
    { id: 'second', name: 'cordis:missing' },
  ]))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.missing = {
    inject: ['presetDependencyOne', 'presetDependencyTwo'],
    apply() { throw new Error('a dependency-blocked plugin must not start') },
  }
  const scoped = createScope(ctx, {})
  await expect(mountPreset(scoped.ctx, { id: 'inactive', trust: 'user', path }))
    .rejects.toThrow(new PresetMountError('inactive', [
      '2 row(s) did not activate:',
      'first (cordis:missing): waiting for presetDependencyOne, presetDependencyTwo',
      `second (cordis:missing): waiting for presetDependencyOne, presetDependencyTwo (${path})`,
    ].join('\n')))
})

it('explains the process-wide effect of mounting without a scope', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await expect(mountPreset(ctx, {
    id: 'unscoped', trust: 'user', path: join(import.meta.dirname, 'fixtures/system/standard/agent.cordis.yml'),
  })).rejects.toThrow('agent-presets: refusing to mount preset "unscoped" into an unscoped context; '
    + 'its registrations would apply to every agent in the process')
})

it.each([false, true])('retains mount and teardown failures through cleanup (terminal observer fails: %s)', async (failAtSettlement) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-cleanup-'))
  const path = join(root, 'agent.cordis.json')
  await writeFile(path, JSON.stringify([{ id: 'leaking', name: 'cordis:leaking' }]))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  const key = {}
  const scoped = createScope(ctx, key)
  const started = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<boolean>()
  let cleaned = false
  let settled = false
  ctx.loader.builtins.leaking = function leaking(pluginCtx: Context): void {
    pluginCtx.provide('presetCleanupLeak', true)
    pluginCtx.effect(() => async () => {
      started.resolve(true)
      await release.promise
      cleaned = true
    })
  }
  const observerFailure = new Error('preset teardown observer failed')
  const settlementFailure = new Error('preset teardown settlement observer failed')
  const removeObserver = ctx.on('internal/status', (fiber) => {
    if (fiber.parent !== scoped.ctx) return
    if (fiber.state === FiberState.UNLOADING) throw observerFailure
    if (fiber.state === FiberState.DISPOSED) {
      removeObserver()
      if (failAtSettlement) throw settlementFailure
    }
  })
  try {
    const completion = Promise.allSettled([
      mountPreset(scoped.ctx, { id: 'cleanup', trust: 'user', path }),
    ]).then((outcomes) => {
      settled = true
      return outcomes
    })
    await started.promise
    await setImmediate()
    expect(settled).toBe(false)
    expect(cleaned).toBe(false)
    release.resolve(true)
    const [outcome] = await completion
    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') throw new Error('invalid preset was accepted')
    const error: unknown = outcome.reason
    expect(error).toBeInstanceOf(PresetMountError)
    if (!(error instanceof PresetMountError)) throw new Error('mount error lost its public error type')
    expect(error.message).toContain('preset teardown observer failed')
    expect(error.cause).toBeInstanceOf(AggregateError)
    if (!(error.cause instanceof AggregateError)) throw new Error('mount error lost its causes')
    expect(error.cause.message).toBe('preset mounting and cleanup failed')
    expect(error.cause.errors).toHaveLength(failAtSettlement ? 3 : 2)
    expect(error.cause.errors[0]).toEqual(new Error('row(s) published process-global service(s) [presetCleanupLeak]; a preset service must sit behind an `isolate` realm or move to the host composition'))
    expect(error.cause.errors[1]).toBe(observerFailure)
    if (failAtSettlement) {
      expect(error.message).toContain('preset teardown settlement observer failed')
      expect(error.cause.errors[2]).toBe(settlementFailure)
    }
    expect(cleaned).toBe(true)
    expect(ctx.get('presetCleanupLeak')).toBeUndefined()
    expect(livePresetMounts().some(mount => mount.key === key)).toBe(false)
  } finally {
    removeObserver()
    release.resolve(true)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
