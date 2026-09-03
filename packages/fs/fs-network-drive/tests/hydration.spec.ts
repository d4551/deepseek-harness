/**
 * What the drive-backed filesystem transfers and when it declines to transfer
 * again: first-read materialization, verified-cache hits, revision moves,
 * tampered local copies, byte bounds on both sides, and binary rejection.
 */

import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { drivePath } from '@deepseek-ai/dsh-network-drive/identity'
import { DriveAddressing } from '../src/addressing.ts'
import { DriveTransfer } from '../src/transfer.ts'
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

    // A verified cache is content-checked, not timestamp- or length-guessed:
    // rewriting the workspace copy behind the provider with the same number of
    // bytes misses even though the record is current.
    await writeFile(fs.processPath(target), 'SECOND')
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

  it('applies the materialization ceiling to a working file the drive does not hold', async () => {
    const tiny = await setup(undefined, { maxFileBytes: 1 })
    await writeFile(join(tiny.root, 'one.txt'), 'a')
    await writeFile(join(tiny.root, 'two.txt'), 'ab')
    await expect(tiny.fs.readText(await tiny.fs.resolve('one.txt'))).resolves.toBe('a')
    await expectCode(tiny.fs.readText(await tiny.fs.resolve('two.txt')), 'FS_TOO_LARGE')

    const wider = await setup(undefined, { maxFileBytes: 2 })
    await writeFile(join(wider.root, 'exact.txt'), 'ab')
    // One character, two UTF-8 bytes: the ceiling counts the bytes it stores,
    // so this sits exactly on it while a second character puts it past.
    await writeFile(join(wider.root, 'multibyte.txt'), 'é')
    await writeFile(join(wider.root, 'multibyte-over.txt'), 'éé')
    await expect(wider.fs.readText(await wider.fs.resolve('exact.txt'))).resolves.toBe('ab')
    await expect(wider.fs.readText(await wider.fs.resolve('multibyte.txt'))).resolves.toBe('é')
    await expectCode(wider.fs.readText(await wider.fs.resolve('multibyte-over.txt')), 'FS_TOO_LARGE')
  })

  it('bounds and classifies the workspace copy at the read itself, not only where it was measured', async () => {
    // The local execution world writes into this directory without the
    // provider's lock, and a materialization root outlives the ceiling any one
    // session booted with, so the size a placement reported is not what the
    // read is allowed to trust.
    const { drive, root } = await setup()
    const config = { materializationRoot: root, remoteRoot: drivePath(''), maxFileBytes: 8 }
    const addressing = new DriveAddressing(config, () => drive)
    const transfer = new DriveTransfer(config, addressing, () => drive)
    await writeFile(join(root, 'grown.txt'), 'x'.repeat(64))

    await expectCode(transfer.readLocal(addressing.targetFor(drivePath('grown.txt')), 'read'), 'FS_TOO_LARGE')
    await expectCode(transfer.readLocal(addressing.targetFor(drivePath('gone.txt')), 'read'), 'FS_NOT_FOUND')
  })

  it('reports a workspace copy removed under an open stream as not found', async () => {
    const { fs } = await setup((d) =>{  d.file('notes.md', 'hello') })
    const target = await fs.resolve('notes.md')
    const stream = await fs.streamText(target)
    await rm(fs.processPath(target))

    const drain = async (): Promise<string[]> => {
      const chunks: string[] = []
      for await (const chunk of stream) chunks.push(chunk)
      return chunks
    }
    await expectCode(drain(), 'FS_NOT_FOUND')
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

  it('reads a file whose first NUL sits past the binary sample, and offers no diff basis for it', async () => {
    // The read judges the leading sample the seam defines; a diff basis is
    // judged over every byte, so the two answer differently for this file.
    const deep = `${'a'.repeat(9000)}\u0000tail`
    const { fs } = await setup((d) =>{  d.file('deep-nul.txt', deep) })
    const target = await fs.resolve('deep-nul.txt')

    await expect(fs.readText(target)).resolves.toBe(deep)
    await expect(fs.writeText(target, 'replacement')).resolves.toMatchObject({ operation: 'update', before: null })
  })
})
