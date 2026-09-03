import { describe, expect, it } from 'vitest'
import { KeyedLock } from '../src/index.ts'

/** A promise plus the resolver the test releases it with. */
function gate() {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  return { promise, open: () => { resolve(undefined) } }
}

describe('KeyedLock', () => {
  it('runs one operation per key at a time, in arrival order', async () => {
    const lock = new KeyedLock()
    const first = gate()
    const order: string[] = []
    const a = lock.run('k', async () => { order.push('a:start'); await first.promise; order.push('a:end'); return 'a' })
    const b = lock.run('k', () => { order.push('b'); return Promise.resolve('b') })
    // Both operations are queued behind a microtask, so the first has not run yet.
    expect(order).toEqual([])
    await Promise.resolve()
    expect(order).toEqual(['a:start'])
    first.open()
    expect(await Promise.all([a, b])).toEqual(['a', 'b'])
    expect(order).toEqual(['a:start', 'a:end', 'b'])
  })

  it('runs different keys concurrently', async () => {
    const lock = new KeyedLock()
    const held = gate()
    const order: string[] = []
    const slow = lock.run('one', async () => { await held.promise; order.push('one') })
    await lock.run('two', () => { order.push('two'); return Promise.resolve() })
    expect(order).toEqual(['two'])
    held.open()
    await slow
    expect(order).toEqual(['two', 'one'])
  })

  it('lets the next caller run after a rejection, and rejects only its own caller', async () => {
    const lock = new KeyedLock()
    const failure = new Error('write failed')
    const failed = lock.run('k', () => Promise.reject(failure))
    const next = lock.run('k', () => Promise.resolve('after'))
    await expect(failed).rejects.toBe(failure)
    expect(await next).toBe('after')
  })

  it('retains a key only while it is in use', async () => {
    const lock = new KeyedLock()
    const held = gate()
    expect(lock.size).toBe(0)
    const running = lock.run('k', () => held.promise)
    expect(lock.size).toBe(1)
    held.open()
    await running
    expect(lock.size).toBe(0)
  })

  it('keeps a key a later caller is still queued behind', async () => {
    const lock = new KeyedLock()
    const held = gate()
    const first = lock.run('k', () => held.promise)
    const second = lock.run('k', () => Promise.resolve())
    held.open()
    await first
    // The first operation settling must not drop the queue the second stands in.
    expect(lock.size).toBe(1)
    await second
    expect(lock.size).toBe(0)
  })
})
