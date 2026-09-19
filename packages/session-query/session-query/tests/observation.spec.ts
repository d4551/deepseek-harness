import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type { BorrowedSessionSource } from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

function header(id: string): SessionHeader {
  return { version: 0, id: SessionId(id), createdAt: 1, cwd: '/workspace' }
}

function preparedSource(
  meta: SessionHeader,
  dispose = vi.fn<() => void>(),
): BorrowedSessionSource {
  const preparedSession = Session.create(meta.id, [], meta)
  return {
    source: 'prepared',
    inspection: { meta: preparedSession.header, events: preparedSession.events },
    revision: SessionPersistenceRevision(`fixture:${meta.id}`),
    preparedSession,
    [Symbol.dispose]: dispose,
  }
}

describe('SessionObservationReader', () => {
  it('prefers a live Session that attaches while a prepared source is borrowed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('attached-during-borrow')
    const dispose = vi.fn<() => void>()
    const prepared = preparedSource(meta, dispose)
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        ctx.sessions.create(meta.id, { meta })
        return Promise.resolve(prepared)
      },
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('live')
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('releases a borrowed source once when the winning live projection fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('attached-projection-failure')
    const dispose = vi.fn<() => void>()
    const prepared = preparedSource(meta, dispose)
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        ctx.sessions.create(meta.id, { meta })
        return Promise.resolve(prepared)
      },
    } as never)
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => {
      throw new Error('projection failed')
    })

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toThrow('projection failed')
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('retries when persistence reports a live source that has already detached', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('detached-live-source')
    const disposeLive = vi.fn<() => void>()
    const prepared = preparedSource(meta)
    const borrowSession = vi.fn<() => Promise<BorrowedSessionSource>>()
      .mockResolvedValueOnce({
        source: 'live', inspection: { meta, events: [] }, [Symbol.dispose]: disposeLive,
      } satisfies BorrowedSessionSource)
      .mockResolvedValueOnce(prepared)
    ctx.provide('sessionPersistence', { borrowSession } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('prepared')
    expect(borrowSession).toHaveBeenCalledTimes(2)
    expect(disposeLive).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('reference-counts prepared leases and rejects retention after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('prepared-leases')
    const dispose = vi.fn<() => void>()
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta, dispose)),
    } as never)
    const observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    observed[Symbol.dispose]()
    expect(dispose).not.toHaveBeenCalled()
    expect(() => observed.retain()).toThrow('is disposed')
    retained[Symbol.dispose]()
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('creates independent live leases and rejects retention after disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('live-leases'), { meta: { cwd: '/workspace' } })
    const reader = new SessionObservationReader(ctx)
    const observed = await reader.read(session.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    expect(() => observed.retain()).toThrow('is disposed')
    expect(retained.source).toBe('live')
    retained[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('contains a non-Error persistence rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.provide('sessionPersistence', {
      // Exercise containment of a backend that violates the Error rejection convention.
      borrowSession: async () => { throw 'offline' },
    } as never)

    await expect(new SessionObservationReader(ctx).read(SessionId('failed'))).rejects.toMatchObject({
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      message: expect.stringContaining('unknown error') as string,
    })
    await ctx.fiber.dispose()
  })

  it('reports a missing Session when persistence is unmounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    await expect(new SessionObservationReader(ctx).read(SessionId('absent'))).rejects.toMatchObject({
      code: 'SESSION_QUERY_SESSION_NOT_FOUND',
      message: 'session "absent" not found',
    })
    await ctx.fiber.dispose()
  })

  it('maps SessionPersistenceNotFoundError onto SESSION_QUERY_SESSION_NOT_FOUND', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const id = SessionId('absent-durable')
    const cause = new SessionPersistenceNotFoundError(id)
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.reject(cause),
    } as never)

    await expect(new SessionObservationReader(ctx).read(id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_SESSION_NOT_FOUND',
      message: `session "${id}" not found`,
      cause,
    })
    await ctx.fiber.dispose()
  })

  it('maps SessionPersistenceCorruptionError onto SESSION_QUERY_CORRUPT_SESSION', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const id = SessionId('corrupt-durable')
    const cause = new SessionPersistenceCorruptionError(
      'stored prefix failed validation',
      { cause: new Error('torn final record') },
    )
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.reject(cause),
    } as never)

    await expect(new SessionObservationReader(ctx).read(id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_CORRUPT_SESSION',
      message: `stored session "${id}" is corrupt: stored prefix failed validation`,
      cause,
    })
    await ctx.fiber.dispose()
  })

  it('preserves an Error persistence rejection message', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const cause = new Error('disk full')
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.reject(cause),
    } as never)

    await expect(new SessionObservationReader(ctx).read(SessionId('failed-disk'))).rejects.toMatchObject({
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      message: 'failed to observe session "failed-disk": disk full',
      cause,
    })
    await ctx.fiber.dispose()
  })

  it('rejects an already-aborted observation before borrowing', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const abort = new AbortController()
    abort.abort()

    await expect(new SessionObservationReader(ctx).read(SessionId('aborted'), { signal: abort.signal }))
      .rejects.toMatchObject({
        code: 'SESSION_QUERY_ABORTED',
        message: 'session observation was aborted',
        cause: abort.signal.reason,
      })
    await ctx.fiber.dispose()
  })

  it('prefers abort over a persistence rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const abort = new AbortController()
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        abort.abort()
        return Promise.reject(new Error('offline'))
      },
    } as never)

    await expect(new SessionObservationReader(ctx).read(SessionId('abort-reject'), { signal: abort.signal }))
      .rejects.toMatchObject({
        code: 'SESSION_QUERY_ABORTED',
        message: 'session observation was aborted',
      })
    await ctx.fiber.dispose()
  })

  it('releases a borrowed source when abort wins after borrow', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('abort-after-borrow')
    const dispose = vi.fn<() => void>()
    const abort = new AbortController()
    ctx.provide('sessionPersistence', {
      borrowSession: () => {
        abort.abort()
        return Promise.resolve(preparedSource(meta, dispose))
      },
    } as never)

    await expect(new SessionObservationReader(ctx).read(meta.id, {
      signal: abort.signal,
      projectionMode: 'none',
    })).rejects.toMatchObject({
      code: 'SESSION_QUERY_ABORTED',
    })
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('rejects a borrowed source whose header identity does not match the request', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const dispose = vi.fn<() => void>()
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(header('other'), dispose)),
    } as never)

    await expect(new SessionObservationReader(ctx).read(SessionId('requested'), { projectionMode: 'none' }))
      .rejects.toMatchObject({
        code: 'SESSION_QUERY_SOURCE_CONFLICT',
        message: 'session persistence returned "other" for "requested"',
      })
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('hydrates prepared projections from the mounted registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('prepared-hydrate')
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta)),
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id)

    expect(observed.source).toBe('prepared')
    expect(observed.cursor).toBe(0)
    expect(observed.projections).toEqual({ asOfSeq: 0, values: {} })
    await ctx.fiber.dispose()
  })

  it('hydrates prepared projections from the mounted cache', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('prepared-cache')
    const snapshot: ProjectionSnapshot = { asOfSeq: 0, values: {} }
    const hydratePrepared = vi.fn<() => ProjectionSnapshot>(() => snapshot)
    ctx.provide('sessionProjectionCache', { hydratePrepared } as never)
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta)),
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id)

    expect(hydratePrepared).toHaveBeenCalledOnce()
    expect(observed.projections).toBe(snapshot)
    await ctx.fiber.dispose()
  })

  it('wraps a prepared projection failure as SESSION_QUERY_CORRUPT_SESSION', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('prepared-projection-failure')
    const dispose = vi.fn<() => void>()
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta, dispose)),
    } as never)
    vi.spyOn(ctx.sessionProjections, 'hydrate').mockImplementation(() => {
      throw new Error('hydrate failed')
    })

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_CORRUPT_SESSION',
      message: 'failed to project session "prepared-projection-failure": hydrate failed',
    })
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('omits prepared projections when the registry is unmounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('prepared-no-registry')
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve(preparedSource(meta)),
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id)

    expect(observed.source).toBe('prepared')
    expect(observed.projections).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('reports cursor -1 for a prepared source with an empty log', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('prepared-empty-log')
    const preparedSession = Session.create(meta.id, undefined, meta)
    ctx.provide('sessionPersistence', {
      borrowSession: () => Promise.resolve({
        source: 'prepared',
        inspection: { meta: preparedSession.header, events: preparedSession.events },
        revision: SessionPersistenceRevision(`fixture:${meta.id}`),
        preparedSession,
        [Symbol.dispose]: () => {},
      } satisfies BorrowedSessionSource),
    } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.events).toEqual([])
    expect(observed.cursor).toBe(-1)
    await ctx.fiber.dispose()
  })

  it('snapshots live projections when the registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('live-projections'), { meta: { cwd: '/workspace' } })

    using observed = await new SessionObservationReader(ctx).read(session.id)

    expect(observed.source).toBe('live')
    expect(observed.projections).toEqual({ asOfSeq: -1, values: {} })
    await ctx.fiber.dispose()
  })
})
