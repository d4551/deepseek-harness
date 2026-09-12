/**
 * The skill catalog cache at its edges: a lexicon listener that throws, a
 * fetch that fails only after an invalidation replaced it, an invalidation
 * for a session nothing fetched, a scope-birth warm that fails, and one of
 * two listeners leaving. The browser-plugin spec owns the happy paths.
 */
import { describe, expect, it, vi } from 'vitest'
import { CATALOG, bench, lexiconHooks, listOk, proj, req, sid } from './bench.client.ts'
import type { ListFn, ListResult } from './bench.client.ts'

describe('the catalog cache at its edges', () => {
  it('contains a throwing lexicon listener so the others still hear the settle', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { source } = await bench(listOk(CATALOG))
    const hooks = lexiconHooks(source)
    const calm = vi.fn()
    hooks.subscribeLexicon(proj('s1'), () => { throw new Error('listener exploded') })
    hooks.subscribeLexicon(proj('s1'), calm)
    await source.candidates(proj('s1'), req(''))
    expect(calm).toHaveBeenCalledTimes(1)
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })

  it('leaves the replacement in place when a fetch fails after an invalidation replaced it', async () => {
    const rejects: ((reason: Error) => void)[] = []
    let calls = 0
    const list: ListFn = (payload) => {
      calls += 1
      return calls === 1
        ? new Promise<ListResult>((_resolve, reject) => { rejects.push(reject) })
        : listOk(CATALOG)(payload)
    }
    const { ctx, source } = await bench(list)
    const stale = source.candidates(proj('s1'), req(''))
    // The reset drops the flying fetch; the next caller starts a fresh one.
    ctx.emit('connection/reset')
    const fresh = source.candidates(proj('s1'), req(''))
    rejects[0]?.(new Error('stale socket'))
    await expect(stale).rejects.toThrow('stale socket')
    await expect(fresh).resolves.toHaveLength(3)
    // The stale failure must not have evicted the fresh entry: no third RPC.
    await expect(source.candidates(proj('s1'), req(''))).resolves.toHaveLength(3)
    expect(calls).toBe(2)
  })

  it('ignores a preset change for a session it never fetched', async () => {
    const { remote, source } = await bench(listOk(CATALOG))
    const hooks = lexiconHooks(source)
    const listener = vi.fn()
    hooks.subscribeLexicon(proj('s9'), listener)
    remote.emit('agent-preset/selected', [sid('s9'), 'minimal'])
    expect(listener).not.toHaveBeenCalled()
    expect(hooks.lexicon(proj('s9'))).toBeUndefined()
  })

  it('swallows a failing scope-birth warm and lets the next caller retry', async () => {
    let calls = 0
    const list: ListFn = (payload) => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('cold host')) : listOk(CATALOG)(payload)
    }
    const { source } = await bench(list)
    lexiconHooks(source).warm(proj('s1'))
    // The warm shares the failing fetch; the failure is the caller's to see.
    await expect(source.candidates(proj('s1'), req(''))).rejects.toThrow('cold host')
    expect(calls).toBe(1)
    await expect(source.candidates(proj('s1'), req(''))).resolves.toHaveLength(3)
    expect(calls).toBe(2)
  })

  it('keeps the other subscriber of a session when one of two leaves', async () => {
    const { source } = await bench(listOk(CATALOG))
    const hooks = lexiconHooks(source)
    const staying = vi.fn()
    const off = hooks.subscribeLexicon(proj('s1'), vi.fn())
    hooks.subscribeLexicon(proj('s1'), staying)
    off()
    await source.candidates(proj('s1'), req(''))
    expect(staying).toHaveBeenCalledTimes(1)
  })
})
