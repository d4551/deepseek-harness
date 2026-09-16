/**
 * SessionProjectionCache behavior: mandatory-point writes (turn/end, detach),
 * count/interval throttling between them, fail-soft durability (a failed
 * write logs and stays stale, never throws into the event path), and the
 * synchronous cached listing read. The durable medium is the
 * `session_projcache` storage domain in per-record layout: one
 * version-stamped document per session under the json backend root at
 * `<root>/session_projcache/sessions/<id>.json`. Reads never touch the
 * medium — they come from the domain's in-memory tables, which writes mutate
 * only after durability.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, Logger } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '../src/index.ts'
import { checkpointRecord, projectionCacheDomainSpec } from '../src/spec.ts'
import type { CheckpointRecord } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'cache-test/marks': MarksState
    'cache-test/marks2': Map<string, string>
    'cache-test/count': number
  }
  interface SessionProjectionMap {
    'cache-test/marks': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cache-test/mark': { marks: string[] }
  }

  interface OutOfBandSessionEventMap {
    'cache-test/mark': true
  }
}

type MarksState = { marks: string[] } | null
const marksUnit = (stateVersion = 1) => ({
  key: 'cache-test/marks',
  stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'cache-test/mark' ? (event).data : state),
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view: state => state ?? { marks: [] },
  },
  stateVersion,
}) satisfies ProjectionDefinition<'cache-test/marks', MarksState>

/** One session's record document on the per-record medium. */
const recordPath = (root: string, id: Session['id']): string =>
  join(root, projectionCacheDomainSpec.name, 'sessions', `${String(id)}.json`)

/** Header shape for cachedSnapshot calls. */
const headerOf = (id: SessionId, createdAt = 0, cwd?: string) =>
  ({ version: 0, id, createdAt, ...cwd === undefined ? {} : { cwd } })

interface HarnessOptions {
  root?: string
  config?: { writeEveryEvents: number; writeIntervalMs: number }
  stateVersion?: number
}

const contexts: Context[] = []
const roots: string[] = []

async function harness(options: HarnessOptions = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  // The cache opens its domain through the storage stack; the json backend
  // lands the per-record tree under this tmp root.
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(marksUnit(options.stateVersion))
  const fiber = await ctx.plugin(SessionProjectionCache, options.config ?? { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  return { ctx, root, fiber, cache: ctx.sessionProjectionCache }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('cache-test/mark', { marks })

const endTurn = (session: Session): SessionEvent =>
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

/** The stored record for one session id (undefined = absent or unreadable). */
async function storedRecord(root: string, id: Session['id']): Promise<CheckpointRecord | undefined> {
  try {
    const document = JSON.parse(await readFile(recordPath(root, id), 'utf8')) as { record: unknown }
    return checkpointRecord.parse(document.record)
  } catch {
    return undefined
  }
}

/** The stored rows for one session id (undefined = absent or unreadable). */
async function storedRows(root: string, id: Session['id']): Promise<CheckpointRecord['rows'] | undefined> {
  return (await storedRecord(root, id))?.rows
}

/** Pre-seed one session's record document with a stored checkpoint record. */
async function seedRecord(
  root: string,
  id: string,
  rows: CheckpointRecord['rows'],
  identity: CheckpointRecord['identity'] = { createdAt: 0 },
): Promise<void> {
  const path = recordPath(root, SessionId(id))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity, rows } }))
}

/** Observe a durable checkpoint; register before the operation that writes it. */
function checkpointAt(ctx: Context, id: SessionId, key: string, seq: number): Promise<CheckpointRecord> {
  const checkpoint = Promise.withResolvers<CheckpointRecord>()
  ctx.on('domain/changed', (change) => {
    if (change.domain !== projectionCacheDomainSpec.name || change.table !== 'sessions'
      || change.key !== id || change.operation !== 'put') return
    const record = checkpointRecord.safeParse(change.value)
    if (!record.success) {
      checkpoint.reject(record.error)
      return
    }
    if (record.data.rows[key]?.seq === seq) checkpoint.resolve(record.data)
  })
  return checkpoint.promise
}

/** Observe the write failure through the logger's public exporter lifecycle. */
function writeWarning(ctx: Context, text: string): Promise<string> {
  const warning = Promise.withResolvers<string>()
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      const formatted = Logger.format(this, message)
      if (message.type === 'warn' && formatted.includes(text)) warning.resolve(formatted)
    },
  })
  return warning.promise
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

describe('SessionProjectionCache write policy', () => {
  it('writes a durable checkpoint at turn/end (mandatory point)', async () => {
    const { ctx, root } = await harness()
    const id = SessionId('turn-end')
    const writes: unknown[] = []
    ctx.on('domain/changed', (change) => {
      if (change.domain === projectionCacheDomainSpec.name && change.key === id && change.operation === 'put') writes.push(change.value)
    })
    const created = checkpointAt(ctx, id, 'cache-test/marks', -1)
    const session = ctx.sessions.create(id)
    mark(session, ['a'])
    // Creation already wrote the init cut; the mark is throttled, so the
    // stored row is still the creation-time cut (no marks folded).
    await created
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.seq).toBe(-1)
    const ended = checkpointAt(ctx, id, 'cache-test/marks', session.seq)
    const end = endTurn(session)
    await ended
    const rows = await storedRows(root, session.id)
    expect(rows?.['cache-test/marks']).toEqual({ ver: 1, seq: end.seq, val: { marks: ['a'] } })
    expect(writes).toMatchObject([
      { rows: { 'cache-test/marks': { seq: -1 } } },
      { rows: { 'cache-test/marks': { seq: end.seq } } },
    ])
  })

  it('writes a checkpoint at session creation, capturing the seed-derived cut', async () => {
    const { ctx, root } = await harness()
    // A forked child seeded with its ancestor's title-like event: no
    // conversation follows, yet the creation write must capture the fold so
    // a crash or a live-held fork still lists the derived value.
    const id = SessionId('seeded')
    const created = checkpointAt(ctx, id, 'cache-test/marks', 1)
    const session = ctx.sessions.create(id, {
      seed: [{ type: 'cache-test/mark', seq: 0, time: 1, data: { marks: ['seed'] } }] as SessionEvent[],
    })
    await created
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.val)
      .toEqual({ marks: ['seed'] })
  })

  it('writes at session disposal (detach, the live-to-cold moment)', async () => {
    const { ctx, root } = await harness()
    // Sessions dispose with their owning fiber: create in a child plugin.
    let session: Session | undefined
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('detach'))
    }, { inject: ['sessions'] }))
    if (session === undefined) throw new Error('session was not created')
    const finalEvent = mark(session, ['live'])
    const checkpoint = checkpointAt(ctx, session.id, 'cache-test/marks', finalEvent.seq)
    await owner.dispose()
    const committed = await checkpoint
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    expect(committed.rows['cache-test/marks']).toEqual({ ver: 1, seq: finalEvent.seq, val: { marks: ['live'] } })
    expect((await storedRows(root, session.id))?.['cache-test/marks']).toEqual(committed.rows['cache-test/marks'])
    expect(ctx.sessionProjectionCache.cachedSnapshot(session.header)).toEqual({
      asOfSeq: finalEvent.seq, values: { 'cache-test/marks': { marks: ['live'] } },
    })
  })

  it('flushes when the in-turn event count reaches the configured threshold', async () => {
    const { ctx, root } = await harness({ config: { writeEveryEvents: 3, writeIntervalMs: 60_000 } })
    const id = SessionId('count')
    const writes: unknown[] = []
    ctx.on('domain/changed', (change) => {
      if (change.domain === projectionCacheDomainSpec.name && change.key === id && change.operation === 'put') writes.push(change.value)
    })
    const created = checkpointAt(ctx, id, 'cache-test/marks', -1)
    const session = ctx.sessions.create(id)
    mark(session, ['1'])
    mark(session, ['2'])
    await created
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.seq).toBe(-1) // still the creation cut
    const flushed = checkpointAt(ctx, id, 'cache-test/marks', session.seq)
    const third = mark(session, ['3'])
    await flushed
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.val).toEqual({ marks: ['3'] })
    expect(writes).toMatchObject([
      { rows: { 'cache-test/marks': { seq: -1 } } },
      { rows: { 'cache-test/marks': { seq: third.seq } } },
    ])
  })

  it('flushes on the configured interval when the count threshold is not reached', async () => {
    const { ctx, cache } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 20 } })
    const write = vi.spyOn(cache, 'write').mockResolvedValue()
    vi.useFakeTimers()
    const session = ctx.sessions.create(SessionId('interval'))
    write.mockClear()
    mark(session, ['slow'])
    await vi.advanceTimersByTimeAsync(19)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledExactlyOnceWith(session)
  })

  it('write() on a never-dirty session checkpoints directly and rejects a non-JSON unit state', async () => {
    const { ctx, root } = await harness()
    // Never dirtied: no events — write() still lands the init-derived cut.
    const clean = ctx.sessions.create(SessionId('clean-write'))
    await ctx.sessionProjectionCache.write(clean)
    expect((await storedRows(root, clean.id))?.['cache-test/marks']).toEqual({ ver: 1, seq: -1, val: null })
    // A unit whose state violates the plain-JSON contract fails the write loud.
    ctx.sessionProjections.register({
      key: 'cache-test/marks2',
      stateSchema: z.custom<Map<string, string>>(() => true),
      init: () => new Map<string, string>(),
      apply: state => state,
      stateVersion: 1,
    })
    await expect(ctx.sessionProjectionCache.write(clean)).rejects.toThrow('not losslessly JSON-serializable')
  })

  it('plugin disposal clears armed interval timers and leaves cleaned sessions alone', async () => {
    vi.useFakeTimers()
    const { ctx, root, fiber } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 5000 } })
    const armed = ctx.sessions.create(SessionId('armed'))
    const cleaned = ctx.sessions.create(SessionId('cleaned'))
    mark(armed, ['pending']) // timer armed, no write yet
    mark(cleaned, ['done'])
    endTurn(cleaned) // mandatory write; markClean leaves {pending: 0, timer: undefined} in the map
    await vi.advanceTimersByTimeAsync(0)
    await fiber.dispose()
    // The armed timer died with the plugin: advancing time writes nothing.
    await vi.advanceTimersByTimeAsync(10_000)
    // Only the creation cut exists: the armed mark never wrote.
    expect((await storedRows(root, armed.id))?.['cache-test/marks']?.seq).toBe(-1)
  })

  it('contains a durable write failure: logs a warning, event path unharmed, next write self-heals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(marksUnit())
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const warning = writeWarning(ctx, 'turn/end write for "fail-soft" failed')
    // A directory where the record document must land makes the atomic
    // rename fail — including the creation write, so no row ever lands.
    const blocker = recordPath(root, SessionId('fail-soft'))
    await mkdir(blocker, { recursive: true })
    const session = ctx.sessions.create(SessionId('fail-soft'))
    mark(session, ['x'])
    endTurn(session)
    const message = await warning
    expect(await storedRows(root, session.id)).toBeUndefined()
    expect(message).toContain('turn/end write for "fail-soft" failed')
    // Self-heal: once the blocker clears, the next mandatory point writes.
    await rm(recordPath(root, session.id), { recursive: true })
    mark(session, ['y'])
    const recovered = checkpointAt(ctx, session.id, 'cache-test/marks', session.seq)
    endTurn(session)
    await recovered
    expect((await storedRows(root, session.id))?.['cache-test/marks']?.val).toEqual({ marks: ['y'] })
  })
})

describe('SessionProjectionCache listing read', () => {
  it('serves identity-matching rows with the cut watermark and refuses unrelated ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'listed', { 'cache-test/marks': { ver: 1, seq: 4, val: { marks: ['t'] } } })
    const { cache } = await harness({ root })
    const id = SessionId('listed')
    // Matching header: values plus the watermark the client seeds under.
    expect(cache.cachedSnapshot(headerOf(id))).toEqual({ asOfSeq: 4, values: { 'cache-test/marks': { marks: ['t'] } } })
    // A recreated id (different createdAt): the record is unrelated — no block.
    expect(cache.cachedSnapshot(headerOf(id, 777))).toBeUndefined()
    // Unknown id: no block.
    expect(cache.cachedSnapshot(headerOf(SessionId('never-cached')))).toBeUndefined()
  })

  it('returns undefined when the stored record is version-mismatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // A stale version-stamped document is discarded at open: absent record.
    const path = recordPath(root, SessionId('all-stale'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: projectionCacheDomainSpec.version + 1,
      record: { identity: { createdAt: 0 }, rows: { 'cache-test/marks': { ver: 1, seq: 4, val: { marks: ['old'] } } } },
    }))
    const { cache } = await harness({ root })
    expect(cache.cachedSnapshot(headerOf(SessionId('all-stale')))).toBeUndefined()
  })

  it('returns undefined when every stored row is version-mismatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // A current document whose rows all fail the live unit's stateVersion:
    // the listing view is empty, so no block is served.
    await seedRecord(root, 'row-stale', { 'cache-test/marks': { ver: 99, seq: 4, val: { marks: ['old'] } } })
    const { cache } = await harness({ root })
    expect(cache.cachedSnapshot(headerOf(SessionId('row-stale')))).toBeUndefined()
  })

  it('binds identity on cwd too: a matching cwd serves, a moved session does not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'homed', { 'cache-test/marks': { ver: 1, seq: 2, val: { marks: ['w'] } } }, { createdAt: 0, cwd: '/work' })
    const { cache } = await harness({ root })
    const id = SessionId('homed')
    expect(cache.cachedSnapshot(headerOf(id, 0, '/work'))?.values['cache-test/marks']).toEqual({ marks: ['w'] })
    expect(cache.cachedSnapshot(headerOf(id, 0, '/elsewhere'))).toBeUndefined()
    expect(cache.cachedSnapshot(headerOf(id, 0))).toBeUndefined()
  })

  it('returns undefined for a malformed record document (refold from the log on the caller side)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const path = recordPath(root, SessionId('malformed'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not json at all')
    const { cache } = await harness({ root })
    expect(cache.cachedSnapshot(headerOf(SessionId('malformed')))).toBeUndefined()
  })
})

describe('SessionProjectionCache cold-read seeding', () => {
  /** One session's event log: turn/start, one mark per group, turn/end. */
  const storedLog = (marks: string[][]): SessionEvent[] => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    ]
    for (const m of marks) {
      events.push({ type: 'cache-test/mark', seq: events.length, time: events.length, data: { marks: m } })
    }
    events.push({ type: 'turn/end', seq: events.length, time: events.length, data: { turn: 1, reason: { kind: 'completed' } } })
    return events
  }

  it('hydratePrepared seeds from a matching row and retries from the exact log on a malformed one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // Records land on disk before the domain opens, so the in-memory table
    // picks them up at init.
    await seedRecord(root, 'prepared-seeded', {
      'cache-test/marks': { ver: 1, seq: 1, val: { marks: ['cached'] } },
    })
    await seedRecord(root, 'prepared-fallback', {
      'cache-test/marks': { ver: 1, seq: 1, val: { marks: 'malformed' } },
    })
    const { cache } = await harness({ root })
    const events = storedLog([['fresh']])

    // A matching row hydrates the prepared Session without a persistence read.
    const seeded = headerOf(SessionId('prepared-seeded'))
    const seededSession = Session.create(seeded.id, events, seeded)
    expect(cache.hydratePrepared(seededSession, seeded, events)).toEqual({
      asOfSeq: 2,
      values: { 'cache-test/marks': { marks: ['cached'] } },
    })

    // A malformed row cannot seed the fold; hydration falls back to the
    // exact log so a valid Session stays readable.
    const fallback = headerOf(SessionId('prepared-fallback'))
    const fallbackSession = Session.create(fallback.id, events, fallback)
    expect(cache.hydratePrepared(fallbackSession, fallback, events)).toEqual({
      asOfSeq: 2,
      values: { 'cache-test/marks': { marks: ['fresh'] } },
    })

    // No row at all: hydrate from init over the exact log.
    const bare = headerOf(SessionId('prepared-bare'))
    const bareSession = Session.create(bare.id, events, bare)
    expect(cache.hydratePrepared(bareSession, bare, events)).toEqual({
      asOfSeq: 2,
      values: { 'cache-test/marks': { marks: ['fresh'] } },
    })
  })

  it('coldSnapshot traverses the full log but applies only the events after each cached watermark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // A cached row covering the prefix through seq 2 (three applies folded).
    await seedRecord(root, 'cold-snap', {
      'cache-test/count': { ver: 1, seq: 2, val: 3 },
    }, { createdAt: 9 })
    const { cache, ctx } = await harness({ root })
    const apply = vi.fn((_state: number, _event: SessionEvent) => 1)
    ctx.sessionProjections.register({
      key: 'cache-test/count',
      stateSchema: z.number().int().nonnegative(),
      init: () => 0,
      apply,
      stateVersion: 1,
    } satisfies ProjectionDefinition<'cache-test/count', number>)
    const meta = headerOf(SessionId('cold-snap'), 9)
    const events = Array.from({ length: 5 }, (_, seq) => ({
      type: 'cache-test/mark', seq, time: seq, data: { marks: [`m${seq}`] },
    })) as SessionEvent[]
    const refreshed = checkpointAt(ctx, meta.id, 'cache-test/count', events.length - 1)
    const snapshot = cache.coldSnapshot(meta, events)
    // The full log was traversed, but the fold applied only seqs 3 and 4.
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls.map(call => call[1].seq)).toEqual([3, 4])
    expect(snapshot.asOfSeq).toBe(4)
    // Host-only unit: folded but not served; the refreshed row is written
    // back (fail-soft, fire-and-forget) once the write lands.
    expect(Object.keys(snapshot.values)).not.toContain('cache-test/count')
    await refreshed
    expect((await storedRows(root, meta.id))?.['cache-test/count']?.seq).toBe(4)
    // No cached row yet: the first cold read folds from init over the full
    // log and creates the cache row (the `?? {}` seed path).
    const fresh = headerOf(SessionId('cold-fresh'), 10)
    const created = checkpointAt(ctx, fresh.id, 'cache-test/count', events.length - 1)
    cache.coldSnapshot(fresh, events)
    expect(apply).toHaveBeenCalledTimes(7) // 2 tail + 5 full
    await created
    expect((await storedRows(root, fresh.id))?.['cache-test/count']?.seq).toBe(4)
  })

  it('coldSnapshot write-back is fail-soft: a failed durable write logs and never throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(marksUnit())
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const warning = writeWarning(ctx, 'cold-read write-back for "cold-fail" failed')
    // A directory where the record document must land makes the write-back
    // fail; the cold read itself still succeeds and never throws.
    const meta = headerOf(SessionId('cold-fail'))
    await mkdir(recordPath(root, meta.id), { recursive: true })
    expect(ctx.sessionProjectionCache.coldSnapshot(meta, [])).toBeDefined()
    expect(await warning).toContain('cold-read write-back for "cold-fail" failed')
  })
})
