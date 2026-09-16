import { Context, Logger } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { installSettingsSection, settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const schema = z.object({ limit: z.number().default(1) })
const namespace = settingsNamespace('consumer-settings')

describe('consumer settings lifecycle', () => {
  it('publishes metadata, validates writes, and updates direct reads without a change callback', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const entry = { limit: 2 }
    let current = () => entry
    installSettingsSection(ctx, namespace, schema, entry, {
      flow: 'consumer',
      applies: 'restart',
      setSource(source) { current = source },
      validate(value) {
        if (value.limit > 5) throw new RangeError('consumer capacity is five')
      },
    })
    expect(current()).toEqual(entry)
    const provider = ctx.plugin(MemorySettings, { doc: { [namespace]: { limit: 3 } } })
    await provider
    expect(current()).toEqual({ limit: 3 })
    expect(ctx.settings.describe()[0]).toMatchObject({ ns: namespace, flow: 'consumer', applies: 'restart' })
    await expect(ctx.settings.update(namespace, { limit: 6 })).rejects.toThrow('consumer capacity is five')
    expect(ctx.settings.describe()[0]?.user).toEqual({ limit: 3 })
    expect(current()).toEqual({ limit: 3 })
    await ctx.settings.update(namespace, { limit: 4 })
    expect(current()).toEqual({ limit: 4 })
    await provider.dispose()
    expect(current()).toBe(entry)
  })

  it('records a logging I/O failure during watcher cleanup and delivers the next update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'settings-log-'))
    const directory = join(root, 'logs')
    const filename = join(directory, 'settings.log')
    const attempted = Promise.withResolvers<undefined>()
    const recovered = Promise.withResolvers<undefined>()
    const ctx = new Context()
    onTestFinished(async () => {
      mkdirSync(directory, { recursive: true })
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    ctx.logger.exporter({
      levels: { default: 3 },
      export(message) {
        attempted.resolve(undefined)
        appendFileSync(filename, `${Logger.format(this, message)}\n`)
        recovered.resolve(undefined)
      },
    })
    await ctx.plugin(MemorySettings)
    const scope = ctx.settings.register(namespace, schema)
    const delivered: number[] = []
    scope.watch((value) => {
      delivered.push(value.limit)
      if (value.limit === 2) throw new Error('consumer rejected update')
    })
    const restoreDirectory = attempted.promise.then(() => { mkdirSync(directory) })
    await scope.update({ limit: 2 })
    await restoreDirectory
    await recovered.promise
    await new Promise(resolve => setImmediate(resolve))
    expect(await readFile(filename, 'utf8')).toContain('ENOENT')
    await scope.update({ limit: 3 })
    await new Promise(resolve => setImmediate(resolve))
    expect(delivered).toEqual([2, 3])
  })
})
