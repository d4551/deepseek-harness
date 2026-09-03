import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Hmr from '@deepseek-ai/cordis-plugin-hmr'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { describe, expect, it, vi } from 'vitest'

type HmrConfig = ConstructorParameters<typeof Hmr>[1]

async function bootHmr(dir: string, root: string[] = [], config: Partial<HmrConfig> = {}): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  // `repairInterval` is stated, not defaulted: these cases assert what the
  // cadence does, so the value they run at belongs in the test.
  await ctx.plugin(Hmr, { root, ignored: [], debounce: 0, repairInterval: 100, ...config })
  return ctx
}

/** Ceiling and cadence every filesystem observation below shares; each call site adds what did not happen. */
const WATCH_POLL = { interval: 10, timeout: 10_000 } as const

describe('HMR exact config paths', () => {
  it('observes module changes when its watch base is a filesystem alias', { timeout: 30_000 }, async () => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-hmr-module-canonical-'))
    const alias = `${target}-alias`
    const aliasFilename = join(alias, 'module.ts')
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(aliasFilename, 'export const generation = 0\n')
    // This acceptance owns alias-to-cache identity. Other cases below exercise
    // native events; polling keeps Windows fs.watch queue pressure out of it.
    const ctx = await bootHmr(alias, ['.'], { usePolling: true })
    const filename = join(await realpath(target), 'module.ts')
    const expected = pathToFileURL(filename).href
    const cacheHas = vi.spyOn(ctx.loader.internal!.loadCache, 'has').mockReturnValue(false)
    const observed: string[] = []
    ctx.on('hmr/change', (url) => { observed.push(url) })
    try {
      const deadline = Date.now() + 20_000
      for (let generation = 1; !observed.includes(expected); generation += 1) {
        if (Date.now() >= deadline) {
          throw new Error(`HMR did not observe ${expected} through the alias; observed ${JSON.stringify(observed)}`)
        }
        // The watch base, not the writer spelling, is the alias under test.
        // Grow the file on every write: polling must not depend on timestamp
        // precision when several generations land inside one filesystem tick.
        writeFileSync(filename, `export const generation = ${generation}\n${' '.repeat(generation)}\n`)
        // Leave Chokidar's atomic-write window idle so one coalesced change can publish.
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      expect(cacheHas).toHaveBeenCalledWith(expected)
    } finally {
      await ctx.fiber.dispose()
      unlinkSync(alias)
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('collapses filesystem aliases before registering an exact watch', async () => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-hmr-canonical-'))
    const alias = `${target}-alias`
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = await bootHmr(alias)
    try {
      await ctx.hmr.registerConfig('plugins.yml', () => {})
      await expect(ctx.hmr.registerConfig(join(await realpath(target), 'plugins.yml'), () => {}))
        .rejects.toThrow('config path already registered')
    } finally {
      await ctx.fiber.dispose()
      unlinkSync(alias)
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('observes add, change, and unlink outside its module roots', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    const observed: string[] = []
    try {
      await ctx.hmr.registerConfig(filename, () => {
        try {
          observed.push(readFileSync(filename, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          observed.push('missing')
        }
      })

      writeFileSync(filename, 'one', { flag: 'wx' })
      await expect.poll(() => observed, { ...WATCH_POLL, message: 'HMR did not observe config creation' })
        .toContain('one')
      writeFileSync(filename, 'two')
      await expect.poll(() => observed, { ...WATCH_POLL, message: 'HMR did not observe config change' })
        .toContain('two')
      unlinkSync(filename)
      await expect.poll(() => observed, { ...WATCH_POLL, message: 'HMR did not observe config removal' })
        .toContain('missing')
      // Add, change, and unlink each reached the callback once, in that order:
      // a repeated event and a repair that finds the generation already
      // announced are both reconciled to nothing.
      expect(observed).toEqual(['one', 'two', 'missing'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('observes creation when the config parent did not exist at registration', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const dir = join(root, 'later')
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(root)
    const observed: string[] = []
    try {
      await ctx.hmr.registerConfig(filename, () => {
        observed.push(readFileSync(filename, 'utf8'))
      })
      mkdirSync(dir)
      writeFileSync(filename, 'created')
      await expect.poll(() => observed, { ...WATCH_POLL, message: 'HMR did not observe config creation under a new parent' })
        .toContain('created')
      // The new parent produced exactly the creation state, nothing else.
      expect(observed).toEqual(['created'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('announces a creation, a change, and a removal no filesystem event reported', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const filename = join(dir, 'plugins.yml')
    // A watch that cannot report inside this case: polling a minute apart, so
    // its initial scan of an empty directory is its only delivery and every
    // observation below is the repair cadence rather than a race with a
    // platform watch. That is what a watch armed after its own readiness
    // signal looks like from here — the change lands in the gap between the
    // finished scan and the armed stream, and no event ever follows it.
    const ctx = await bootHmr(dir, [], {
      usePolling: true,
      interval: 60_000,
      binaryInterval: 60_000,
      repairInterval: 20,
    })
    const observed: string[] = []
    try {
      await ctx.hmr.registerConfig(filename, () => {
        try {
          observed.push(readFileSync(filename, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          observed.push('missing')
        }
      })

      writeFileSync(filename, 'created', { flag: 'wx' })
      await expect.poll(() => observed, { ...WATCH_POLL, message: 'the repair cadence did not announce an unreported creation' })
        .toContain('created')
      // Same byte length as the generation before it: content, not stat
      // metadata, is what the cadence compares.
      writeFileSync(filename, 'changed')
      await expect.poll(() => observed, { ...WATCH_POLL, message: 'the repair cadence did not announce an unreported change' })
        .toContain('changed')
      unlinkSync(filename)
      await expect.poll(() => observed, { ...WATCH_POLL, message: 'the repair cadence did not announce an unreported removal' })
        .toContain('missing')
      // The cadence ran many times between those three assertions; each
      // generation still reached the callback exactly once.
      expect(observed).toEqual(['created', 'changed', 'missing'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes refreshes and waits for them during disposal', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const filename = join(dir, 'plugins.yml')
    writeFileSync(filename, 'one')
    const ctx = await bootHmr(dir)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const observed: string[] = []
    let active = 0
    let maxActive = 0
    try {
      const dispose = await ctx.hmr.registerConfig(filename, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        observed.push(readFileSync(filename, 'utf8'))
        if (observed.length === 1) {
          started.resolve(undefined)
          await release.promise
        }
        active -= 1
      })
      await started.promise
      writeFileSync(filename, 'two')
      // Chokidar coalesces atomic writes for 100 ms by default. Wait beyond
      // that window so this edit is queued before registration disposal.
      await new Promise(resolve => setTimeout(resolve, 250))

      let disposed = false
      const disposal = dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await disposal
      expect(maxActive).toBe(1)
      expect(observed).toEqual(['one', 'two'])
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('normalizes refresh failures and broadcasts them without escaping the watcher', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    const failure = Promise.withResolvers<{ filename: string; error: Error }>()
    let failureCount = 0
    try {
      ctx.on('hmr/config-update-failed', () => {
        throw new Error('observer failed')
      })
      ctx.on('hmr/config-update-failed', (failedFilename, error) => {
        failureCount += 1
        failure.resolve({ filename: failedFilename, error })
      })
      await ctx.hmr.registerConfig(filename, () => { throw 42 })
      writeFileSync(filename, 'invalid')

      const observed = await failure.promise
      expect(observed.filename).toBe(filename)
      expect(observed.error).toBeInstanceOf(Error)
      expect(observed.error.message).toBe('42')

      // No wait for Chokidar's per-path change throttle: an event it throttles
      // away is a generation the repair cadence announces like any other one
      // no filesystem event reported.
      writeFileSync(filename, 'invalid again')
      await expect.poll(() => failureCount, { ...WATCH_POLL, message: 'HMR stopped broadcasting after an observer rejected' })
        .toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
