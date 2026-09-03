/**
 * Publication failures and guards: what a failed or raced write does to the
 * workspace and the drive, precondition surfaces, over-limit publications, and
 * serialization of concurrent guarded mutations of one target.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DriveError } from '@deepseek-ai/dsh-network-drive/identity'
import { expectCode, setup } from './harness.ts'

describe('NetworkDriveFileSystem publication failures and guards', () => {
  it('fails the write and leaves both sides unchanged when the drive refuses the publication', async () => {
    const { fs, drive } = await setup((d) => { d.file('notes.md', 'kept') })
    const target = await fs.resolve('notes.md')
    await fs.readText(target)

    drive.nextWriteError = new DriveError('the drive is offline', 'DRIVE_IO_ERROR')
    await expectCode(fs.writeText(target, 'lost'), 'FS_IO_ERROR')

    expect(drive.contentOf('notes.md')).toBe('kept')
    await expect(readFile(fs.processPath(target), 'utf8')).resolves.toBe('kept')
    // The failed attempt left no trace the next read could mistake for a hit.
    await expect(fs.readText(target)).resolves.toBe('kept')
  })

  it('rejects a guarded write whose drive revision another writer already replaced', async () => {
    const { fs, drive } = await setup((d) => { d.file('shared.md', 'original') })
    const target = await fs.resolve('shared.md')
    const observed = (await fs.stat(target))!.version

    drive.mutate('shared.md', 'another writer')
    await expectCode(
      fs.writeText(target, 'mine', { kind: 'replaceIfVersion', version: observed }),
      'FS_STALE_VERSION',
    )
    await expectCode(
      fs.editText(target, { oldString: 'another', newString: 'mine', replaceAll: false }, { version: observed }),
      'FS_STALE_VERSION',
    )
    expect(drive.contentOf('shared.md')).toBe('another writer')

    const current = (await fs.stat(target))!.version
    await expect(fs.writeText(target, 'mine', { kind: 'replaceIfVersion', version: current }))
      .resolves.toMatchObject({ operation: 'update' })
    expect(drive.contentOf('shared.md')).toBe('mine')
  })

  it('rejects a guarded write over an oversize working file another writer replaced with the same byte count', async () => {
    const { fs, root } = await setup(undefined, { maxFileBytes: 8 })
    const workspaceCopy = join(root, 'oversize.txt')
    await writeFile(workspaceCopy, 'AAAAAAAAAAAA')
    const target = await fs.resolve('oversize.txt')
    const observed = (await fs.stat(target))!.version

    // Same length, different bytes: only a content-derived version can tell the
    // two apart, and the guard is the only thing standing between them.
    await writeFile(workspaceCopy, 'BBBBBBBBBBBB')
    expect((await fs.stat(target))!.version).not.toBe(observed)

    await expectCode(
      fs.writeText(target, 'mine', { kind: 'replaceIfVersion', version: observed }),
      'FS_STALE_VERSION',
    )
    await expect(readFile(workspaceCopy, 'utf8')).resolves.toBe('BBBBBBBBBBBB')
  })

  it('surfaces a drive-side precondition failure as a stale version', async () => {
    const { fs, drive } = await setup((d) => { d.file('raced.md', 'original') })
    const target = await fs.resolve('raced.md')

    // The revision moves after the guard was checked and before the drive commits.
    drive.onWrite = () => {
      drive.mutate('raced.md', 'winner')
      drive.onWrite = undefined
    }
    await expectCode(fs.writeText(target, 'loser'), 'FS_STALE_VERSION')
    expect(drive.contentOf('raced.md')).toBe('winner')
  })

  it('honors create-if-absent and refuses to write over a directory', async () => {
    const { fs } = await setup((d) => {
      d.file('present.md', 'here')
      d.directory('folder')
    })

    await expectCode(
      fs.writeText(await fs.resolve('present.md'), 'x', { kind: 'createIfAbsent' }),
      'FS_NOT_OBSERVED',
    )
    await expectCode(fs.writeText(await fs.resolve('folder'), 'x'), 'FS_NOT_REGULAR_FILE')
    await expectCode(fs.editText(await fs.resolve('folder'), { oldString: 'a', newString: 'b', replaceAll: false }), 'FS_NOT_REGULAR_FILE')
    await expectCode(fs.editText(await fs.resolve('absent.md'), { oldString: 'a', newString: 'b', replaceAll: false }), 'FS_STALE_VERSION')
    await expect(fs.writeText(await fs.resolve('fresh.md'), 'new', { kind: 'createIfAbsent' }))
      .resolves.toMatchObject({ operation: 'create' })
  })

  it('rejects an over-limit publication before it reaches the drive', async () => {
    const { fs, drive } = await setup(undefined, { maxFileBytes: 8 })
    await expectCode(fs.writeText(await fs.resolve('big.md'), 'x'.repeat(64)), 'FS_TOO_LARGE')
    expect(drive.writes).toHaveLength(0)
  })

  it('serializes concurrent guarded mutations of one target', async () => {
    const { fs } = await setup((d) => { d.file('one.md', 'base') })
    const target = await fs.resolve('one.md')
    const version = (await fs.stat(target))!.version

    const results = await Promise.allSettled([
      fs.writeText(target, 'one', { kind: 'replaceIfVersion', version }),
      fs.editText(target, { oldString: 'base', newString: 'two', replaceAll: false }, { version }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
})
