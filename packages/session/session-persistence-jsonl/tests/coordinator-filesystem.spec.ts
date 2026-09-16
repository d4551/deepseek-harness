import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '../src/index.ts'
import { toHeaderLine } from '../src/format.ts'

describe('coordinator filesystem ownership', () => {
  let root: string
  let ctx: Context
  const readers: Context[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-coordinator-filesystem-'))
    ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  })

  afterEach(async () => {
    for (const reader of readers.splice(0)) await reader.fiber.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects an ownerless prefix claim after its durable artifact disappears', async () => {
    const original = Session.create(SessionId('removed-prefix'))
    original.append('turn/start', { turn: 1 })
    original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const persistence = ctx.sessionPersistence
    await persistence.create(original.header)
    await persistence.append(original.id, original.events)
    const loaded = await persistence.load(original.id)
    const location = persistence.locate(loaded.meta)
    if (location === undefined) throw new Error('JSONL artifact location is required')
    await rm(location.path)

    const live = ctx.sessions.create(original.id, { seed: loaded.events, meta: loaded.meta })
    await expect(ctx.sessions.flush(live)).rejects.toThrow('do not match this live session (id collision)')
    await expect(readFile(location.path)).rejects.toMatchObject({ code: 'ENOENT' })

    const reader = new Context()
    readers.push(reader)
    await reader.plugin(SessionStore)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(reader.sessionPersistence.list()).resolves.toEqual([])
    await expect(reader.sessionPersistence.load(original.id)).rejects.toThrow('not found')
  })

  it('refuses a committed turn ending with non-record data without rewriting its bytes', async () => {
    const session = ctx.sessions.create(SessionId('malformed-ending'))
    await ctx.sessionPersistence.ensureMaterialized(session)
    const location = ctx.sessionPersistence.locate(session.header)
    if (location === undefined) throw new Error('JSONL artifact location is required')
    const content = [
      toHeaderLine(session.header),
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: null },
    ].map(record => JSON.stringify(record)).join('\n') + '\n'
    await writeFile(location.path, content)

    const reader = new Context()
    readers.push(reader)
    await reader.plugin(SessionStore)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(reader.sessionPersistence.inspect(session.id)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    await expect(reader.sessionPersistence.load(session.id)).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
    await expect(reader.sessionPersistence.readFrom(session.id, 0))
      .rejects.toThrow('malformed pre-react-loop turn/end at seq 1')
    expect(await readFile(location.path, 'utf8')).toBe(content)
  })

  it('materializes an immediately created empty session and preserves its header after retirement', async () => {
    const session = ctx.sessions.create(SessionId('immediate-header'))
    await ctx.sessionPersistence.ensureMaterialized(session)
    const location = ctx.sessionPersistence.locate(session.header)
    if (location === undefined) throw new Error('JSONL artifact location is required')
    const before = await readFile(location.path, 'utf8')
    expect(before).toBe(JSON.stringify(toHeaderLine(session.header)) + '\n')
    await ctx.fiber.dispose()

    const reader = new Context()
    readers.push(reader)
    await reader.plugin(SessionStore)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expect(reader.sessionPersistence.load(session.id)).resolves.toEqual({
      meta: { ...session.header, delegationDepth: 0 }, events: [],
    })
    expect(await readFile(location.path, 'utf8')).toBe(before)
  })
})
