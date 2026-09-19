import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { setActiveVfs } from '../../src/storage/active.ts'
import { FSWatcher, unwatchFile, watchAsync, watchFile } from '../../src/node/builtin_modules/implemented/fs-watch.ts'

const VFS_ROOT = '/dsh/watch-leftover-thrown'
let vfs: MemoryVfs

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync(VFS_ROOT, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('watchAsync leftover Thrown claim', () => {
  it.each([
    ['watch denied', 'watch denied'],
    [404, '404'],
    [false, 'false'],
    [8n, '8'],
    [Symbol.for('watch'), 'Symbol(watch)'],
    [undefined, 'undefined'],
    [null, 'null'],
    [{ code: 'EACCES' }, '[object Object]'],
  ] as const)('claims a leftover startup throw %s as the waiting reject', async (reason, message) => {
    vi.spyOn(vfs, 'statSync').mockImplementationOnce(() => { throw reason })
    const iterator = watchAsync(`${VFS_ROOT}/denied`)
    await expect(iterator.next()).rejects.toThrow(message)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('claims a leftover function startup throw as the waiting reject', async () => {
    const reason = (): undefined => undefined
    vi.spyOn(vfs, 'statSync').mockImplementationOnce(() => { throw reason })
    const iterator = watchAsync(`${VFS_ROOT}/denied`)
    await expect(iterator.next()).rejects.toThrow(String(reason))
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('claims a leftover watcher error string as the waiting reject', async () => {
    const spy = vi.spyOn(FSWatcher.prototype, 'on')
    const iterator = watchAsync(VFS_ROOT)
    const pending = iterator.next()
    const watcher = spy.mock.instances[0]
    if (!(watcher instanceof FSWatcher)) throw new Error('watchAsync did not register a watcher')
    watcher.emit('error', 'watcher string')
    await expect(pending).rejects.toThrow('watcher string')
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('stores a leftover watcher error until the next read when no waiter is pending', async () => {
    const spy = vi.spyOn(FSWatcher.prototype, 'on')
    const iterator = watchAsync(VFS_ROOT)
    const first = iterator.next()
    vfs.writeFileSync(`${VFS_ROOT}/one.txt`, 'one')
    await expect(first).resolves.toEqual({ done: false, value: { eventType: 'rename', filename: 'one.txt' } })
    const watcher = spy.mock.instances[0]
    if (!(watcher instanceof FSWatcher)) throw new Error('watchAsync did not register a watcher')
    watcher.emit('error', 77)
    await expect(iterator.next()).rejects.toThrow('77')
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('claims leftover abort reasons through settleFailure without wrapping the iterator in then()', async () => {
    const waiting = new AbortController()
    const iterator = watchAsync(VFS_ROOT, { signal: waiting.signal })
    const pending = iterator.next()
    waiting.abort('abort string')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause: 'abort string' })

    const preaborted = new AbortController()
    preaborted.abort(undefined)
    const refused = watchAsync(VFS_ROOT, { signal: preaborted.signal })
    await expect(refused.next()).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    await expect(refused.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('does not settle a leftover error after the iterator has already closed', async () => {
    const spy = vi.spyOn(FSWatcher.prototype, 'on')
    const iterator = watchAsync(VFS_ROOT)
    const pending = iterator.next()
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    const watcher = spy.mock.instances[0]
    if (!(watcher instanceof FSWatcher)) throw new Error('watchAsync did not register a watcher')
    watcher.emit('error', 'after close')
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('claims leftover chmod, overlapping poll, and timer ref through the same Thrown watcher', async () => {
    const path = `${VFS_ROOT}/chmod.txt`
    vfs.writeFileSync(path, 'x')
    const change = Promise.withResolvers<string>()
    const watcher = new FSWatcher(path, false, {}, (eventType) => { change.resolve(eventType) })
    vfs.chmodSync(path, 0o600)
    await expect(change.promise).resolves.toBe('change')
    watcher.close()

    const missing = `${VFS_ROOT}/never-created-leftover`
    const polled = watchFile(missing, { interval: 50, persistent: false }, () => {})
    polled.ref()
    polled.unref()
    vfs.writeFileSync(missing, 'x')
    unwatchFile(missing)
    polled.stop()
  })
})
