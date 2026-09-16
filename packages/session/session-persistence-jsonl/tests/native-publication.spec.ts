import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import JsonlSessionPersistence from '../src/index.ts'
import { projectDir, toHeaderLine, type JsonlCompression } from '../src/format.ts'
import { compressZstdFrame, decompressZstdPrefix, scanZstdFrames } from '../src/zstd.ts'

describe.each<{ compression: JsonlCompression }>([
  { compression: 'none' },
  { compression: 'zstd' },
])('JSONL native publication: $compression', ({ compression }) => {
  it('rejects a second materialization without changing the committed artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-collision-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      const backend = ctx.sessionPersistence
      if (!(backend instanceof JsonlSessionPersistence)) throw new Error('JSONL backend was not registered')
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION, id: SessionId('occupied'), createdAt: 1,
      }
      await backend.materializeHeader(header)
      const path = backend.locate(header).path
      const committed = await readFile(path)

      await expect(backend.materializeHeader({ ...header, createdAt: 2 }))
        .rejects.toThrow('a log already exists on disk')
      expect(await readFile(path)).toEqual(committed)
      expect(await readdir(dirname(path))).toEqual([compression === 'none' ? 'session.jsonl' : 'session.jsonl.zstd'])
      expect((await backend.loadStored(header.id))?.meta.createdAt).toBe(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes exactly one complete artifact when independent owners race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-publication-'))
    const first = new Context()
    const second = new Context()
    try {
      await first.plugin(SessionStore)
      await second.plugin(SessionStore)
      await first.plugin(JsonlSessionPersistence, { root, compression })
      await second.plugin(JsonlSessionPersistence, { root, compression })
      const firstBackend = first.sessionPersistence
      const secondBackend = second.sessionPersistence
      if (!(firstBackend instanceof JsonlSessionPersistence) || !(secondBackend instanceof JsonlSessionPersistence)) {
        throw new Error('JSONL backends were not registered')
      }
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION, id: SessionId('contended'), createdAt: 1,
      }
      const results = await Promise.allSettled([
        firstBackend.materializeHeader(header),
        secondBackend.materializeHeader({ ...header, createdAt: 2 }),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const failures = results.filter(result => result.status === 'rejected')
      expect(failures).toHaveLength(1)
      for (const failure of failures) {
        expect(failure.reason).toBeInstanceOf(Error)
        if (!(failure.reason instanceof Error)) throw new Error('publication failed without an Error')
        expect(failure.reason.message).toMatch(/EEXIST|a log already exists on disk/)
      }
      const winner = results.findIndex(result => result.status === 'fulfilled') + 1
      const path = firstBackend.locate(header).path
      expect(await readdir(dirname(path))).toEqual([compression === 'none' ? 'session.jsonl' : 'session.jsonl.zstd'])
      expect((await firstBackend.loadStored(header.id))?.meta.createdAt).toBe(winner)
      expect((await secondBackend.loadStored(header.id))?.meta.createdAt).toBe(winner)
      expect((await firstBackend.readRaw(header.id))?.content)
        .toBe(JSON.stringify(toHeaderLine({ ...header, createdAt: winner })) + '\n')
    } finally {
      await first.fiber.dispose()
      await second.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('surfaces native identity-resolution errors without repairing or replacing the artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-identity-'))
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(JsonlSessionPersistence, { root, compression })
      const backend = ctx.sessionPersistence
      if (!(backend instanceof JsonlSessionPersistence)) throw new Error('JSONL backend was not registered')
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION, id: SessionId('identity'), createdAt: 1,
      }
      const path = backend.locate(header).path
      const redirected = { ...header, cwd: '/identity-loop' }
      const expectedProject = projectDir(root, redirected.cwd)
      await mkdir(dirname(path), { recursive: true })
      await symlink(expectedProject, expectedProject, 'junction')
      const text = JSON.stringify(toHeaderLine(redirected)) + '\n'
      const bytes = compression === 'none' ? Buffer.from(text) : await compressZstdFrame(text)
      await writeFile(path, bytes)

      await expect(backend.list()).rejects.toMatchObject({ code: 'ELOOP' })
      await expect(backend.loadStored(header.id)).rejects.toMatchObject({ code: 'ELOOP' })
      expect(await readFile(path)).toEqual(bytes)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('retains the committed prefix when an incomplete Zstandard frame cannot be decoded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-torn-dictionary-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const backend = ctx.sessionPersistence
    if (!(backend instanceof JsonlSessionPersistence)) throw new Error('JSONL backend was not registered')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: SessionId('torn-dictionary'), createdAt: 1,
    }
    const headerFrame = await compressZstdFrame(JSON.stringify(toHeaderLine(header)) + '\n')
    const eventFrame = await compressZstdFrame(
      JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }) + '\n',
    )
    const descriptor = eventFrame.readUInt8(4)
    expect(descriptor & 0x03).toBe(0)
    const dictionaryOffset = (descriptor & 0x20) === 0 ? 6 : 5
    const tornFrame = Buffer.concat([
      eventFrame.subarray(0, dictionaryOffset), Buffer.from([1]), eventFrame.subarray(dictionaryOffset, -1),
    ])
    // A nonzero dictionary id requires its dictionary; the final checksum is also incomplete.
    tornFrame.writeUInt8(descriptor | 0x01, 4)
    expect(scanZstdFrames(tornFrame)).toEqual({ frames: [], tornStart: 0 })
    await expect(decompressZstdPrefix(tornFrame)).rejects.toThrow(/dictionary/i)
    const path = backend.locate(header).path
    const bytes = Buffer.concat([headerFrame, tornFrame])
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)

    const stored = await backend.loadStored(header.id)
    expect(stored?.meta).toMatchObject(header)
    expect(stored?.events).toEqual([])
    expect(stored?.tornMarker).toEqual({ truncateTo: headerFrame.length, recoveredEvents: [] })
    expect(await readFile(path)).toEqual(bytes)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
