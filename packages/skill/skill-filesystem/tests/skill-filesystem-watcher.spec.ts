import { EventEmitter } from 'node:events'
import type { Stats } from 'node:fs'
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

interface FakeWatcherControl {
  emitter: EventEmitter
  closeCalls: number
  options: Record<string, unknown>
  path: string
}

interface FakeWatchFileControl {
  path: string
  listener(current: Stats, previous: Stats): void
}

interface FakeStatGate {
  started: PromiseWithResolvers<undefined>
  release: PromiseWithResolvers<undefined>
}

const watcherHarness = vi.hoisted(() => ({
  watchers: [] as FakeWatcherControl[],
  startupErrors: [] as Error[],
  closeErrors: 0,
  closeRejections: [] as Array<object | string | number | boolean | bigint | symbol | null | undefined>,
  closeGates: [] as FakeStatGate[],
  deferredReady: 0,
  watchFiles: [] as FakeWatchFileControl[],
  statGates: [] as FakeStatGate[],
  statFailures: [] as Array<object | string | number | boolean | bigint | symbol | null | undefined>,
  statAbsentAll: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watchFile(path: string, _options: unknown, listener: FakeWatchFileControl['listener']) {
      watcherHarness.watchFiles.push({ path, listener })
    },
    unwatchFile(path: string, listener: FakeWatchFileControl['listener']) {
      const index = watcherHarness.watchFiles.findIndex(control => control.path === path && control.listener === listener)
      if (index !== -1) watcherHarness.watchFiles.splice(index, 1)
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async stat(...args: Parameters<typeof actual.stat>) {
      if (watcherHarness.statAbsentAll) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      const failure = watcherHarness.statFailures.shift()
      if (failure !== undefined) throw failure
      const gate = watcherHarness.statGates.shift()
      if (gate !== undefined) {
        gate.started.resolve(undefined)
        await gate.release.promise
      }
      return await actual.stat(...args)
    },
  }
})

vi.mock('chokidar', () => ({
  default: {
    watch(path: unknown, options: Record<string, unknown>) {
      const emitter = new EventEmitter() as EventEmitter & { close(): Promise<void> }
      const control: FakeWatcherControl = { emitter, closeCalls: 0, options, path: String(path) }
      emitter.close = async () => {
        control.closeCalls += 1
        const gate = watcherHarness.closeGates.shift()
        if (gate !== undefined) {
          gate.started.resolve(undefined)
          await gate.release.promise
        }
        const rejection = watcherHarness.closeRejections.shift()
        if (rejection !== undefined) throw rejection
        if (watcherHarness.closeErrors > 0) {
          watcherHarness.closeErrors -= 1
          throw new Error('close failed')
        }
      }
      watcherHarness.watchers.push(control)
      queueMicrotask(() => {
        if (watcherHarness.deferredReady > 0) {
          watcherHarness.deferredReady -= 1
          return
        }
        const error = watcherHarness.startupErrors.shift()
        if (error === undefined) emitter.emit('ready')
        else emitter.emit('error', error)
      })
      return emitter
    },
  },
}))

const SkillFileSystem = await import('../src/index.ts')

async function tempDir(name: string): Promise<string> {
  return await import('node:fs/promises').then(fs => fs.mkdtemp(join(tmpdir(), `dsh-${name}-`)))
}

async function writeSkill(root: string, name: string): Promise<void> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\nBody.\n`)
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  watcherHarness.watchers.length = 0
  watcherHarness.startupErrors.length = 0
  watcherHarness.closeErrors = 0
  watcherHarness.closeRejections.length = 0
  watcherHarness.closeGates.length = 0
  watcherHarness.deferredReady = 0
  watcherHarness.watchFiles.length = 0
  watcherHarness.statGates.length = 0
  watcherHarness.statFailures.length = 0
  watcherHarness.statAbsentAll = false
})

describe('skill-filesystem watcher failures', () => {
  it('canonicalizes an existing root before opening its native watcher', async () => {
    const target = await tempDir('skill-watch-canonical-target')
    const aliasParent = await tempDir('skill-watch-canonical-alias')
    const alias = join(aliasParent, 'alias')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const root = join(alias, '.dsh/skills')
    await writeSkill(root, 'canonical-skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(alias, '.dsh'),
      agentsHome: join(alias, '.agents'),
      watch: true,
    })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['canonical-skill'])
    expect(watcherHarness.watchers[0]?.path).toBe(await realpath(root))
    expect(watcherHarness.watchers[0]?.options.persistent).toBe(true)
    await fiber.dispose()
  })

  it('preserves a symlink root when link following is disabled', async () => {
    const target = await tempDir('skill-watch-link-target')
    const aliasParent = await tempDir('skill-watch-link-alias')
    const alias = join(aliasParent, 'skills')
    await writeSkill(target, 'linked-skill')
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [alias],
      watch: true,
      watchFollowSymlinks: false,
    })

    try {
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['linked-skill'])
      expect(watcherHarness.watchers[0]?.path).toBe(alias)
      expect(watcherHarness.watchers[0]?.options.followSymlinks).toBe(false)
    } finally {
      await fiber.dispose()
      await rm(aliasParent, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it('ignores missing-path probes until the observed path actually changes', async () => {
    const home = await tempDir('skill-watch-missing-stable')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })
    expect(watcherHarness.watchFiles).toHaveLength(2)
    let invalidations = 0
    ctx.on('skills/change', () => { invalidations += 1 })

    for (const control of watcherHarness.watchFiles) {
      control.listener({} as Stats, {} as Stats)
    }
    await settle()

    expect(invalidations).toBe(0)
    expect(watcherHarness.watchFiles).toHaveLength(2)
    await fiber.dispose()
  })

  it('keeps skills loadable across persistent watcher startup failures without caching them', async () => {
    const home = await tempDir('skill-watch-start-error')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'retry-skill')
    watcherHarness.startupErrors.push(
      new Error('watch failed once'),
      new Error('watch failed twice'),
      new Error('watch failed three times'),
    )
    watcherHarness.closeErrors = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchUsePolling: true,
      watchFollowSymlinks: false,
      watchPollIntervalMs: 10,
      watchStabilityThresholdMs: 20,
    })

    expect(await ctx.skills.snapshot()).toMatchObject({
      skills: [{ name: 'retry-skill' }],
      complete: false,
    })
    expect((await ctx.skills.get('retry-skill'))?.content).toBe('Body.')
    expect(await ctx.skills.snapshot()).toMatchObject({
      skills: [{ name: 'retry-skill' }],
      complete: false,
    })
    expect(watcherHarness.watchers).toHaveLength(3)
    expect(watcherHarness.watchers[0]?.options).toMatchObject({
      atomic: true,
      depth: 1,
      followSymlinks: false,
      usePolling: true,
      interval: 10,
      awaitWriteFinish: {
        stabilityThreshold: 20,
        pollInterval: 10,
      },
    })

    await fiber.dispose()
  })

  it('filters events, coalesces invalidation, recovers runtime errors, and contains late callbacks', async () => {
    const home = await tempDir('skill-watch-runtime-error')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'watched-skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
      watchStabilityThresholdMs: 20,
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['watched-skill'])
    let invalidations = 0
    ctx.on('skills/change', () => { invalidations += 1 })
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected a root watcher')

    first.emitter.emit('change', join(first.path, 'notes.txt'))
    first.emitter.emit('change', join(home, 'outside.md'))
    first.emitter.emit('change', join(first.path, 'watched-skill/references.md'))
    first.emitter.emit('change', join(first.path, '.system/SKILL.md'))
    await settle()
    expect(invalidations).toBe(0)

    first.emitter.emit('change', join(first.path, 'watched-skill/SKILL.md'))
    first.emitter.emit('change', join(first.path, 'watched-skill/SKILL.md'))
    await settle()
    expect(invalidations).toBe(1)

    watcherHarness.closeErrors = 1
    watcherHarness.startupErrors.push(new Error('runtime rewatch failed'))
    first.emitter.emit('error', new Error('runtime watch failed'))
    await vi.waitFor(() => { expect(watcherHarness.watchers.length).toBeGreaterThanOrEqual(2) })
    expect(invalidations).toBeGreaterThanOrEqual(2)
    expect(await ctx.skills.snapshot()).toMatchObject({
      skills: [{ name: 'watched-skill' }],
      complete: true,
    })

    await fiber.dispose()
    first.emitter.emit('change', join(first.path, 'watched-skill/SKILL.md'))
    first.emitter.emit('error', new Error('late error'))
    await settle()
  })

  it('replaces a retained watcher when its root emits unlinkDir', async () => {
    const home = await tempDir('skill-watch-root-unlink')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'removed-skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
      watchStabilityThresholdMs: 20,
    })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['removed-skill'])
    const original = watcherHarness.watchers[0]
    if (original === undefined) throw new Error('expected a root watcher')

    await rm(root, { recursive: true })
    original.emitter.emit('unlinkDir', original.path)
    await vi.waitFor(() => { expect(original.closeCalls).toBeGreaterThan(0) })
    await vi.waitFor(() => {
      expect(watcherHarness.watchFiles.some(control => control.path === original.path)).toBe(true)
    })

    await fiber.dispose()
  })

  it('re-probes a retained root after child unlink and observes immediate recreation', async () => {
    const home = await tempDir('skill-watch-root-reprobe')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'old-skill')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
      watchStabilityThresholdMs: 20,
    })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['old-skill'])
    const original = watcherHarness.watchers[0]
    if (original === undefined) throw new Error('expected a root watcher')

    await rm(root, { recursive: true })
    original.emitter.emit('unlink', join(original.path, 'old-skill/SKILL.md'))
    await settle()
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })

    const missingRoot = watcherHarness.watchFiles.find(control => control.path === original.path)
    expect(missingRoot).toBeDefined()
    await writeSkill(root, 'recreated-skill')
    missingRoot!.listener({} as Stats, {} as Stats)
    await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(2) })
    await settle()

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['recreated-skill'])
    await fiber.dispose()
  })

  it('settles an opening watcher when plugin disposal races its ready event', async () => {
    const home = await tempDir('skill-watch-opening-dispose')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'racing-skill')
    watcherHarness.deferredReady = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const disposeProvider = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: true,
        watchPollIntervalMs: 10,
        watchStabilityThresholdMs: 20,
      })
      return provider
    })

    const discovery = provider.list({})
    await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(1) })
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected an opening root watcher')
    const disposal = provider.dispose()

    await expect(discovery).rejects.toThrow('skill-filesystem watcher disposed')
    await disposal
    disposeProvider()
    await settle()
    expect(first.closeCalls).toBeGreaterThan(0)
  })

  it('closes an opening watcher when disposal wins the mode probe', async () => {
    const home = await tempDir('skill-watch-probe-dispose')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'racing-skill')
    watcherHarness.deferredReady = 1
    const statGate: FakeStatGate = {
      started: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
    }
    watcherHarness.statGates.push(statGate)
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const disposeProvider = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: true,
        watchPollIntervalMs: 10,
        watchStabilityThresholdMs: 20,
      })
      return provider
    })

    const discovery = provider.list({})
    await statGate.started.promise
    const disposal = provider.dispose()
    statGate.release.resolve(undefined)

    await expect(discovery).rejects.toThrow('skill-filesystem watcher disposed')
    await disposal
    expect(watcherHarness.watchers).toHaveLength(1)
    expect(watcherHarness.watchers[0]?.closeCalls).toBeGreaterThan(0)
    disposeProvider()
  })

  it('contains an opening watcher rejection during provider teardown', async () => {
    const home = await tempDir('skill-watch-opening-reject')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'rejected-skill')
    watcherHarness.deferredReady = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const disposeProvider = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        dshHome: join(home, '.dsh'),
        agentsHome: join(home, '.agents'),
        watch: true,
        watchPollIntervalMs: 10,
        watchStabilityThresholdMs: 20,
      })
      return provider
    })

    const discovery = provider.list({})
    await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(1) })
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected an opening root watcher')
    first.emitter.emit('error', new Error('opening failed during disposal'))
    const disposal = provider.dispose()

    await expect(discovery).rejects.toThrow('opening failed during disposal')
    await disposal
    disposeProvider()
  })

  it('contains a mode re-probe rejection after the native watcher handle opens', async () => {
    const home = await tempDir('skill-watch-reprobe-reject')
    const root = join(home, 'skills')
    await writeSkill(root, 'reprobe-skill')
    watcherHarness.deferredReady = 1
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [root],
      watch: true,
      watchPollIntervalMs: 10,
    })
    const discovery = ctx.skills.snapshot()
    await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(1) })
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected an opening root watcher')
    watcherHarness.statFailures.push(Object.assign(new Error('reprobe denied'), { code: 'EACCES' }))
    first.emitter.emit('ready')
    expect(await discovery).toMatchObject({
      skills: [{ name: 'reprobe-skill' }],
      complete: false,
    })
    expect(warnings.some(message => message.includes('reprobe denied'))).toBe(true)
    await fiber.dispose()
  })

  it('treats an unexpected ancestor probe failure as a watcher error', async () => {
    const home = await tempDir('skill-watch-ancestor-reject')
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })
    expect(watcherHarness.watchFiles.length).toBeGreaterThan(0)
    watcherHarness.statFailures.push(Object.assign(new Error('ancestor denied'), { code: 'EACCES' }))
    const probe = watcherHarness.watchFiles[0]
    if (probe === undefined) throw new Error('expected an ancestor probe')
    probe.listener({} as Stats, {} as Stats)
    await settle()
    expect(warnings.some(message => message.includes('ancestor denied'))).toBe(true)
    await fiber.dispose()
  })

  it.each([
    ['string', 'boom-string', 'boom-string'],
    ['number', 42, '42'],
    ['boolean', false, 'false'],
    ['bigint', 7n, '7'],
    ['symbol', Symbol.for('skill-watch-thrown'), 'Symbol(skill-watch-thrown)'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['plain object', Object.create(null), '[object Object]'],
    ['function', function thrownWatcher() {}, 'function thrownWatcher'],
  ] as const)('renders a %s runtime watcher failure', async (_kind, thrown, text) => {
    const home = await tempDir(`skill-watch-thrown-${String(_kind).replaceAll(' ', '-')}`)
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'thrown-skill')
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['thrown-skill'])
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected a root watcher')
    first.emitter.emit('error', thrown)
    await settle()
    expect(warnings.some(message => message.includes(text))).toBe(true)
    await fiber.dispose()
  })

  it('contains a scheduled rewatch and queued invalidation when disposal wins the next turn', async () => {
    const home = await tempDir('skill-watch-dispose-rewatch')
    const root = join(home, '.dsh/skills')
    await writeSkill(root, 'dispose-rewatch')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['dispose-rewatch'])
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected a root watcher')
    first.emitter.emit('change', join(first.path, 'dispose-rewatch/SKILL.md'))
    first.emitter.emit('error', new Error('rewatch after dispose'))
    await fiber.dispose()
  })

  it('drains every watcher close when a close warning rejects', async () => {
    const home = await tempDir('skill-watch-drain-close')
    const root = join(home, 'skills')
    await writeSkill(root, 'drain-close')
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
      throw message
    }) as typeof ctx.logger.warn
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [root],
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['drain-close'])
    watcherHarness.closeRejections.push('close-primitive')
    await fiber.dispose()
    expect(watcherHarness.watchers.every(control => control.closeCalls > 0)).toBe(true)
    expect(warnings.some(message => message.includes('close-primitive'))).toBe(true)
  })

  it('replaces a watcher whose root disappears between open and re-probe', async () => {
    const home = await tempDir('skill-watch-mode-shift')
    const root = join(home, 'skills')
    await writeSkill(root, 'shift-skill')
    watcherHarness.deferredReady = 1
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [root],
      watch: true,
      watchPollIntervalMs: 10,
    })
    const discovery = ctx.skills.snapshot()
    await vi.waitFor(() => { expect(watcherHarness.watchers).toHaveLength(1) })
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected an opening root watcher')
    await rm(root, { recursive: true })
    first.emitter.emit('ready')
    expect((await discovery).skills).toEqual([])
    await vi.waitFor(() => {
      expect(watcherHarness.watchFiles.some(control => control.path === first.path)).toBe(true)
    })
    expect(first.closeCalls).toBeGreaterThan(0)
    await fiber.dispose()
  })

  it('abandons an opening replacement when disposal wins the previous close', async () => {
    const home = await tempDir('skill-watch-replace-abort')
    const root = join(home, 'skills')
    await writeSkill(root, 'replace-abort')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [root],
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['replace-abort'])
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected a root watcher')
    const closeGate: FakeStatGate = {
      started: Promise.withResolvers<undefined>(),
      release: Promise.withResolvers<undefined>(),
    }
    watcherHarness.closeGates.push(closeGate)
    first.emitter.emit('unlinkDir', first.path)
    await closeGate.started.promise
    const disposal = fiber.dispose()
    closeGate.release.resolve(undefined)
    await disposal
    expect(first.closeCalls).toBeGreaterThan(0)
  })

  it('contains a late ancestor probe after disposal', async () => {
    const home = await tempDir('skill-watch-late-ancestor')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      dshHome: join(home, '.dsh'),
      agentsHome: join(home, '.agents'),
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })
    const probe = watcherHarness.watchFiles[0]
    if (probe === undefined) throw new Error('expected an ancestor probe')
    await fiber.dispose()
    watcherHarness.statFailures.push(Object.assign(new Error('late ancestor'), { code: 'EACCES' }))
    probe.listener({} as Stats, {} as Stats)
    await settle()
  })

  it('drops a queued invalidation when disposal wins the microtask', async () => {
    const home = await tempDir('skill-watch-invalidation-abort')
    const root = join(home, 'skills')
    await writeSkill(root, 'queued-skill')
    const ctx = new Context()
    let invalidations = 0
    ctx.on('skills/change', () => { invalidations += 1 })
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const disposeProvider = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        includeDefaultRoots: false,
        customSkillDirs: [root],
        watch: true,
        watchPollIntervalMs: 10,
      })
      return provider
    })
    const listed = await provider.list({})
    expect((Array.isArray(listed) ? listed : listed.candidates).map(skill => skill.name)).toEqual(['queued-skill'])
    const before = invalidations
    const first = watcherHarness.watchers[0]
    if (first === undefined) throw new Error('expected a root watcher')
    first.emitter.emit('change', join(first.path, 'queued-skill/SKILL.md'))
    await provider.dispose()
    expect(invalidations).toBe(before)
    disposeProvider()
  })

  it('observes a rejected provider dispose from the registration abort listener', async () => {
    const home = await tempDir('skill-watch-abort-dispose')
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
    await ctx.plugin(SkillRegistry)
    let provider!: InstanceType<typeof SkillFileSystem.FileSystemSkillProvider>
    const disposeProvider = ctx.skills.registerProvider((control) => {
      provider = new SkillFileSystem.FileSystemSkillProvider(ctx, control, {
        includeDefaultRoots: false,
        customSkillDirs: [home],
        watch: false,
      })
      return provider
    })
    provider.dispose = () => Promise.reject('dispose-failed')
    disposeProvider()
    await settle()
    expect(errors).toContain('dispose-failed')
  })

  it('walks to the filesystem root when every watch-mode probe is absent', async () => {
    const home = await tempDir('skill-watch-absent-all')
    const root = join(home, 'skills')
    watcherHarness.statAbsentAll = true
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillFileSystem, {
      includeDefaultRoots: false,
      customSkillDirs: [root],
      watch: true,
      watchPollIntervalMs: 10,
    })
    expect(await ctx.skills.snapshot()).toEqual({ skills: [], complete: true })
    expect(watcherHarness.watchFiles.length).toBeGreaterThan(0)
    await fiber.dispose()
  })
})
