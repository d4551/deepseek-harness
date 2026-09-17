import { Context, Logger } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { settingsNamespace, type SettingsScope } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

it('awaits a started callback after unsubscribe when disposing its registration', async () => {
  const ctx = new Context()
  const started = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const registered = Promise.withResolvers<SettingsScope<{ value: number }>>()
  onTestFinished(async () => {
    released.resolve(undefined)
    await ctx.fiber.dispose()
  })
  await ctx.plugin(MemorySettings)
  const registryChanges: string[][] = []
  ctx.on('settings/registry-updated', () => {
    registryChanges.push(ctx.settings.describe().map(section => String(section.ns)))
  })
  const owner = ctx.plugin({
    inject: ['settings'],
    apply(child: Context) {
      registered.resolve(child.settings.register(settingsNamespace('disposal'), z.object({ value: z.number().default(0) })))
    },
  })
  await owner
  const scope = await registered.promise
  let finished = false
  let calls = 0
  const unsubscribe = scope.watch(async () => {
    calls += 1
    started.resolve(undefined)
    await released.promise
    finished = true
  })
  await scope.update({ value: 1 })
  await started.promise
  unsubscribe()
  await scope.update({ value: 2 })
  let disposed = false
  const disposal = owner.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(disposed).toBe(false)
  expect(finished).toBe(false)
  released.resolve(undefined)
  await disposal
  expect(finished).toBe(true)
  expect(calls).toBe(1)
  expect(ctx.settings.describe()).toEqual([])
  expect(registryChanges).toEqual([['disposal'], []])
})

it('waits for every started callback when reporting a sibling failure encounters an I/O error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'settings-disposal-log-'))
  const directory = join(root, 'logs')
  const filename = join(directory, 'settings.log')
  const attempted = Promise.withResolvers<undefined>()
  const firstStarted = Promise.withResolvers<undefined>()
  const secondStarted = Promise.withResolvers<undefined>()
  const fail = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const registered = Promise.withResolvers<SettingsScope<{ value: number }>>()
  const ctx = new Context()
  onTestFinished(async () => {
    mkdirSync(directory, { recursive: true })
    fail.resolve(undefined)
    release.resolve(undefined)
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      attempted.resolve(undefined)
      appendFileSync(filename, `${Logger.format(this, message)}\n`)
    },
  })
  await ctx.plugin(MemorySettings)
  const registryChanges: string[][] = []
  ctx.on('settings/registry-updated', () => {
    registryChanges.push(ctx.settings.describe().map(section => String(section.ns)))
  })
  const owner = ctx.plugin({
    inject: ['settings'],
    apply(child: Context) {
      registered.resolve(child.settings.register(settingsNamespace('disposal'), z.object({ value: z.number().default(0) })))
    },
  })
  await owner
  const scope = await registered.promise
  scope.watch(async () => {
    firstStarted.resolve(undefined)
    await fail.promise
    throw new Error('first observer failed')
  })
  let finished = false
  scope.watch(async () => {
    secondStarted.resolve(undefined)
    await release.promise
    finished = true
  })
  await scope.update({ value: 1 })
  await Promise.all([firstStarted.promise, secondStarted.promise])
  let disposed = false
  const disposal = owner.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  const restoreDirectory = attempted.promise.then(() => { mkdirSync(directory) })
  fail.resolve(undefined)
  await restoreDirectory
  await new Promise(resolve => setImmediate(resolve))
  const recoveryLog = await readFile(filename, 'utf8')
  expect(recoveryLog).toContain('ENOENT')
  expect(disposed).toBe(false)
  expect(finished).toBe(false)
  release.resolve(undefined)
  await disposal
  expect(finished).toBe(true)
  expect(registryChanges).toEqual([['disposal'], []])
  expect((await readFile(filename, 'utf8')).slice(recoveryLog.length)).toContain('ENOENT')
})
