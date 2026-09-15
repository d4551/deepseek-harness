import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { expect, it, onTestFinished } from 'vitest'
import { FileSettingsProvider } from '../src/index.ts'

it('announces registration lifetimes independently of stored values and capability readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-settings-registry-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'settings.yaml')
  const initial = 'registry-owner:\n  count: 2\n'
  await writeFile(path, initial)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(FileSettingsProvider, { path })
  const namespace = settingsNamespace('registry-owner')
  const schema = z.object({ count: z.number().step(1).min(1).required() })
  const directoryEvents: string[][] = []
  const documentEvents: number[] = []
  const readinessEvents: boolean[] = []
  const watcherStarted = Promise.withResolvers<undefined>()
  const finishWatcher = Promise.withResolvers<undefined>()
  onTestFinished(() => { finishWatcher.resolve(undefined) })
  ctx.on('settings/registry-updated', (ns) => {
    expect(ns).toBe(namespace)
    directoryEvents.push(ctx.settings.describe().map(row => String(row.ns)))
  })
  ctx.on('settings/document-updated', (_ns, revision) => { documentEvents.push(revision) })
  ctx.on('settings/availability-updated', (_ns, available) => { readinessEvents.push(available) })

  const owner = await ctx.plugin({
    name: 'registry-owner',
    inject: ['settings'],
    apply(ownerCtx) {
      const scope = ownerCtx.settings.register(namespace, schema)
      expect(scope.get()).toEqual({ count: 2 })
      scope.setAvailable(false)
      scope.watch(() => {
        watcherStarted.resolve(undefined)
        return finishWatcher.promise
      })
    },
  })
  expect(directoryEvents).toEqual([[namespace]])
  expect(readinessEvents).toEqual([false])
  expect(documentEvents).toEqual([])
  expect(await readFile(path, 'utf8')).toBe(initial)
  expect(() => ctx.settings.register(namespace, schema)).toThrow('already registered')
  await ctx.settings.update(namespace, { count: 3 })
  expect(directoryEvents).toEqual([[namespace]])
  expect(documentEvents).toEqual([1])
  const committed = await readFile(path, 'utf8')

  await watcherStarted.promise
  const disposal = owner.dispose()
  await expect.poll(() => ctx.settings.describe()).toEqual([])
  expect(directoryEvents).toEqual([[namespace]])
  finishWatcher.resolve(undefined)
  await disposal
  expect(directoryEvents).toEqual([[namespace], []])
  expect(ctx.settings.describe()).toEqual([])
  expect(readinessEvents).toEqual([false])
  expect(documentEvents).toEqual([1])
  expect(await readFile(path, 'utf8')).toBe(committed)

  const replacement = await ctx.plugin({
    name: 'registry-replacement',
    inject: ['settings'],
    apply(ownerCtx) {
      ownerCtx.settings.register(namespace, schema)
    },
  })
  expect(directoryEvents).toEqual([[namespace], [], [namespace]])
  expect(ctx.settings.describe()[0]).toMatchObject({ value: { count: 3 }, revision: 0 })
  await replacement.dispose()
  expect(directoryEvents).toEqual([[namespace], [], [namespace], []])
  expect(documentEvents).toEqual([1])
  expect(readinessEvents).toEqual([false])
  expect(await readFile(path, 'utf8')).toBe(committed)
})
