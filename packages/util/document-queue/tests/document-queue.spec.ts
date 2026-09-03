import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DocumentQueue, isENOENT, readDocumentText, resolveDocumentSpec } from '../src/index.ts'

// chokidar is the nondeterministic OS boundary: faking it drives the event
// pipeline (change, ready, error) deterministically. Real end-to-end watching
// stays covered by the settings-file and credentials-local suites.
vi.mock('chokidar', async () => {
  const { EventEmitter: FakeEmitter } = await import('node:events')
  class FakeWatcher extends FakeEmitter {
    close = vi.fn(() => Promise.resolve())
  }
  const instances: Array<{ path: string; options: unknown; watcher: FakeWatcher }> = []
  return {
    watch: vi.fn((path: string, options: unknown) => {
      const watcher = new FakeWatcher()
      instances.push({ path, options, watcher })
      return watcher
    }),
    __instances: instances,
  }
})

interface FakeChokidar {
  __instances: Array<{
    path: string
    options: { ignoreInitial: boolean; awaitWriteFinish: { stabilityThreshold: number; pollInterval: number } }
    watcher: EventEmitter & { close: ReturnType<typeof vi.fn> }
  }>
}

async function fakeInstances(): Promise<FakeChokidar['__instances']> {
  const chokidar = await import('chokidar') as unknown as FakeChokidar
  return chokidar.__instances
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  ;(await fakeInstances()).length = 0
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-document-queue-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Records what the queue reports, standing in for `ctx.logger`. */
function recordingLogger() {
  const warned: unknown[][] = []
  const errored: unknown[][] = []
  return {
    warned,
    errored,
    warn: (format: unknown, ...parameters: unknown[]) => { warned.push([format, ...parameters]) },
    error: (format: unknown, ...parameters: unknown[]) => { errored.push([format, ...parameters]) },
  }
}

function queueFor(filename: string, reconcile: () => Promise<void>, debounceMs = 100) {
  const logger = recordingLogger()
  const queue = new DocumentQueue({ label: 'test-owner', filename, debounceMs, logger, reconcile })
  cleanups.push(() => queue.close())
  return { queue, logger }
}

describe('resolveDocumentSpec', () => {
  it('prefers an explicit path and keeps explicit watch settings', async () => {
    const dir = await tempDir()
    const path = join(dir, 'nested', 'doc.yaml')

    expect(resolveDocumentSpec({ path, watch: false, debounceMs: 5 }, 'settings.yaml')).toEqual({
      filename: resolve(path),
      watch: false,
      debounceMs: 5,
    })
  })

  it('falls back to the basename under the configured harness home with watching on', async () => {
    const dir = await tempDir()

    expect(resolveDocumentSpec({ dshHome: dir }, '.credentials.yaml')).toEqual({
      filename: resolve(join(dir, '.credentials.yaml')),
      watch: true,
      debounceMs: 100,
    })
  })
})

describe('readDocumentText', () => {
  it('returns the text of an existing document', async () => {
    const dir = await tempDir()
    const path = join(dir, 'doc.yaml')
    await writeFile(path, 'a: 1\n')

    await expect(readDocumentText(path)).resolves.toBe('a: 1\n')
  })

  it('reports absence as undefined', async () => {
    const dir = await tempDir()

    await expect(readDocumentText(join(dir, 'missing.yaml'))).resolves.toBeUndefined()
  })

  it('surfaces every read failure that is not absence', async () => {
    const dir = await tempDir()

    await expect(readDocumentText(dir)).rejects.toThrow(/EISDIR|EPERM|EACCES/)
  })
})

describe('isENOENT', () => {
  it('recognizes only a missing-path errno', () => {
    expect(isENOENT(Object.assign(new Error('gone'), { code: 'ENOENT' }))).toBe(true)
    expect(isENOENT(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toBe(false)
    expect(isENOENT(null)).toBe(false)
  })
})

describe('DocumentQueue operations', () => {
  it('runs queued operations in arrival order and keeps the tail alive after a rejection', async () => {
    const dir = await tempDir()
    const { queue } = queueFor(join(dir, 'doc.yaml'), () => Promise.resolve())
    const order: string[] = []

    const first = queue.enqueue(async () => {
      await Promise.resolve()
      order.push('first')
      throw new Error('first failed')
    })
    const second = queue.enqueue(() => {
      order.push('second')
      return Promise.resolve('second value')
    })

    await expect(first).rejects.toThrow('first failed')
    await expect(second).resolves.toBe('second value')
    expect(order).toEqual(['first', 'second'])
  })

  it('reports closure and drains in-flight work at close', async () => {
    const dir = await tempDir()
    const { queue } = queueFor(join(dir, 'doc.yaml'), () => Promise.resolve())
    let released!: () => void
    const holding = new Promise<void>((resolveHold) => { released = resolveHold })
    let settled = false

    const operation = queue.enqueue(async () => {
      await holding
      settled = true
    })
    expect(queue.isClosed()).toBe(false)

    const closing = queue.close()
    expect(queue.isClosed()).toBe(true)
    released()
    await closing
    await operation
    expect(settled).toBe(true)
  })
})

describe('DocumentQueue reloads', () => {
  it('keeps the last good document and warns when a reload fails', async () => {
    const dir = await tempDir()
    const { queue, logger } = queueFor(join(dir, 'doc.yaml'), () => Promise.reject(new Error('unparsable')))

    queue.queueReload()
    await queue.enqueue(() => Promise.resolve())

    expect(logger.warned[0]?.[0]).toBe('%s: reload failed at %s; keeping the last good document')
    expect(logger.errored).toEqual([])
  })

  it('reports an invariant violation escaping the owner as a commit failure', async () => {
    const dir = await tempDir()
    const violation = Object.assign(new Error('invariant violated'), { code: 'INVARIANT' })
    const { queue, logger } = queueFor(join(dir, 'doc.yaml'), () => Promise.reject(violation))

    queue.queueReload()
    await queue.enqueue(() => Promise.resolve())

    expect(logger.errored[0]?.[0]).toBe('%s: reload commit failed at %s')
    expect(logger.errored[1]?.[0]).toBe(violation)
    expect(logger.warned).toEqual([])
  })

  it('skips a reload queued before close and reached after it', async () => {
    const dir = await tempDir()
    let reconciled = 0
    const { queue } = queueFor(join(dir, 'doc.yaml'), () => {
      reconciled += 1
      return Promise.resolve()
    })

    queue.queueReload()
    await queue.close()

    expect(reconciled).toBe(0)
  })
})

describe('DocumentQueue watching', () => {
  it('queues a reload for a change and for watcher readiness, and stops at close', async () => {
    const dir = await tempDir()
    let reconciled = 0
    const { queue } = queueFor(join(dir, 'doc.yaml'), () => {
      reconciled += 1
      return Promise.resolve()
    }, 40)

    await queue.watch()
    const [instance] = await fakeInstances()
    expect(instance?.path).toBe(join(await realpath(dir), 'doc.yaml'))
    expect(instance?.options.ignoreInitial).toBe(true)
    expect(instance?.options.awaitWriteFinish).toEqual({ stabilityThreshold: 40, pollInterval: 10 })

    instance?.watcher.emit('all', 'change')
    instance?.watcher.emit('ready')
    await queue.enqueue(() => Promise.resolve())
    expect(reconciled).toBe(2)

    await queue.close()
    expect(instance?.watcher.close).toHaveBeenCalled()
    instance?.watcher.emit('all', 'change')
    instance?.watcher.emit('ready')
    await queue.enqueue(() => Promise.resolve())
    expect(reconciled).toBe(2)
  })

  it('clamps the poll interval to the settle window and warns on a watcher error', async () => {
    const dir = await tempDir()
    const { queue, logger } = queueFor(join(dir, 'doc.yaml'), () => Promise.resolve(), 0)

    await queue.watch()
    const [instance] = await fakeInstances()
    expect(instance?.options.awaitWriteFinish).toEqual({ stabilityThreshold: 0, pollInterval: 1 })

    const failure = new Error('watcher failed')
    instance?.watcher.emit('error', failure)
    expect(logger.warned[0]?.[0]).toBe('%s: watcher error on %s')
    expect(logger.warned[1]?.[0]).toBe(failure)
  })
})
