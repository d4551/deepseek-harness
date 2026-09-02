/**
 * What the drive-backed filesystem transfers and when it declines to transfer
 * again: first-read materialization, verified-cache hits, revision moves,
 * tampered local copies, byte bounds, and binary rejection.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { expectCode, setup } from './harness.ts'

describe('NetworkDriveFileSystem hydration', () => {
  it('materializes a drive file on first read and answers later reads from the verified copy', async () => {
    const { fs, drive } = await setup((d) =>{  d.file('notes.md', 'hello') })
    const target = await fs.resolve('notes.md')

    await expect(fs.readText(target)).resolves.toBe('hello')
    expect(drive.reads).toHaveLength(1)
    // The hard constraint: a real OS process can open what processPath returns.
    expect(existsSync(fs.processPath(target))).toBe(true)
    await expect(readFile(fs.processPath(target), 'utf8')).resolves.toBe('hello')

    await expect(fs.readText(target)).resolves.toBe('hello')
    await expect(fs.readText(target)).resolves.toBe('hello')
    expect(drive.reads).toHaveLength(1)
  })

  it('transfers again when the drive revision moved or the local copy stopped matching its digest', async () => {
    const { fs, drive } = await setup((d) =>{  d.file('notes.md', 'first') })
    const target = await fs.resolve('notes.md')
    await expect(fs.readText(target)).resolves.toBe('first')

    drive.mutate('notes.md', 'second')
    await expect(fs.readText(target)).resolves.toBe('second')
    expect(drive.reads).toHaveLength(2)

    // A verified cache is content-checked, not timestamp-guessed: rewriting the
    // workspace copy behind the provider misses even though the record is current.
    await writeFile(fs.processPath(target), 'tampered')
    await expect(fs.readText(target)).resolves.toBe('second')
    expect(drive.reads).toHaveLength(3)
    await expect(readFile(fs.processPath(target), 'utf8')).resolves.toBe('second')
  })

  it('bounds every transfer with a byte range and refuses an oversized file', async () => {
    const { fs, drive } = await setup((d) =>{  d.file('big.txt', 'x'.repeat(64)) }, { maxFileBytes: 16 })
    const target = await fs.resolve('big.txt')

    await expectCode(fs.readText(target), 'FS_TOO_LARGE')
    drive.file('small.txt', 'ok')
    const small = await fs.resolve('small.txt')
    await expect(fs.readText(small)).resolves.toBe('ok')
    expect(drive.reads.at(-1)?.range).toEqual({ offset: 0, length: 17 })
  })

  it('streams and byte-reads the materialized copy under the caller bound', async () => {
    const { fs } = await setup((d) =>{  d.file('text.txt', 'A€B') })
    const target = await fs.resolve('text.txt')

    const chunks: string[] = []
    for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
    expect(chunks.join('')).toBe('A€B')
    await expect(fs.readBytes(target, undefined, 64)).resolves.toEqual(new TextEncoder().encode('A€B'))
    await expectCode(fs.readBytes(target, undefined, 2), 'FS_TOO_LARGE')
  })

  it('rejects binary content as unreadable text', async () => {
    const { fs } = await setup((d) => {
      d.nodes.set('binary.bin', { type: 'file', bytes: Uint8Array.from([65, 0, 66]), revision: 9 })
    })
    const target = await fs.resolve('binary.bin')

    await expectCode(fs.readText(target), 'FS_NOT_TEXT')
    const drain = async (): Promise<string> => {
      const chunks: string[] = []
      for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
      return chunks.join('')
    }
    await expectCode(drain(), 'FS_NOT_TEXT')
  })
})
