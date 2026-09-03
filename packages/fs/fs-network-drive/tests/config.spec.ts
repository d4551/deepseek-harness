/**
 * Cancellation, drive-failure translation, configuration validation, remote
 * subtree scoping, and the package-owned invariant installer's lifecycle.
 */

import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { DriveError } from '@deepseek-ai/dsh-network-drive/identity'
import type { DriveErrorCode } from '@deepseek-ai/dsh-network-drive/types'
import NetworkDriveFileSystem from '../src/index.ts'
import * as FsNetworkDriveInvariant from '../src/invariant.ts'
import { expectCode, FakeDrive, setup } from './harness.ts'

describe('NetworkDriveFileSystem cancellation and configuration', () => {
  it('threads the caller signal into the drive and reports an abort as one', async () => {
    const { fs, drive } = await setup((d) => { d.file('notes.md', 'content') })
    const target = await fs.resolve('notes.md')

    const pre = new AbortController()
    pre.abort()
    await expectCode(fs.readText(target, pre.signal), 'FS_ABORTED')
    await expectCode(fs.stat(target, pre.signal), 'FS_ABORTED')
    await expectCode(fs.writeText(target, 'x', undefined, pre.signal), 'FS_ABORTED')

    // The drive receives the caller's own signal, so an abort raised in flight
    // arrives from the drive rather than from a local check after the fact.
    const midflight = new AbortController()
    drive.onStat = () => {
      midflight.abort()
      drive.onStat = undefined
    }
    await expectCode(fs.readText(target, midflight.signal), 'FS_ABORTED')
    expect(drive.signals).toContain(midflight.signal)
  })

  it('maps every drive failure code onto the filesystem vocabulary', async () => {
    const { fs, drive } = await setup((d) => { d.file('notes.md', 'content') })
    const target = await fs.resolve('notes.md')

    const cases: Array<[DriveErrorCode, string]> = [
      ['DRIVE_NOT_FOUND', 'FS_NOT_FOUND'],
      ['DRIVE_NOT_DIRECTORY', 'FS_NOT_DIRECTORY'],
      ['DRIVE_NOT_FILE', 'FS_NOT_REGULAR_FILE'],
      ['DRIVE_PERMISSION_DENIED', 'FS_PERMISSION_DENIED'],
      ['DRIVE_UNAUTHENTICATED', 'FS_PERMISSION_DENIED'],
      ['DRIVE_PRECONDITION_FAILED', 'FS_STALE_VERSION'],
      ['DRIVE_TOO_LARGE', 'FS_TOO_LARGE'],
      ['DRIVE_ABORTED', 'FS_ABORTED'],
      ['DRIVE_IO_ERROR', 'FS_IO_ERROR'],
    ]
    for (const [driveCode, fsCode] of cases) {
      drive.nextReadError = new DriveError('drive said no', driveCode)
      drive.mutate('notes.md', `content ${driveCode}`)
      await expectCode(fs.readText(target), fsCode)
    }
    drive.nextReadError = new Error('transport vanished')
    drive.mutate('notes.md', 'again')
    await expectCode(fs.readText(target), 'FS_IO_ERROR')
  })

  it('refuses a relative materialization root or a non-positive file ceiling', async () => {
    const ctx = new Context()
    new FakeDrive(ctx)
    // `bun test` does not unwrap a cordis Fiber thenable the way vitest does, so
    // adopt it into a real promise before asserting the rejection.
    await expect(Promise.resolve(ctx.plugin(NetworkDriveFileSystem, { materializationRoot: 'relative' })))
      .rejects.toThrow('materializationRoot must be an absolute path')
    await expect(Promise.resolve(ctx.plugin(NetworkDriveFileSystem, { materializationRoot: tmpdir(), maxFileBytes: 0 })))
      .rejects.toThrow('maxFileBytes must be a positive integer')
    await ctx.fiber.dispose()
  })

  it('mirrors only the configured remote subtree', async () => {
    const { fs, drive } = await setup((d) => { d.file('team/space/report.md', 'scoped') }, { remoteRoot: 'team/space' })
    const target = await fs.resolve('report.md')

    await expect(fs.readText(target)).resolves.toBe('scoped')
    expect(drive.reads.at(0)?.path).toBe('team/space/report.md')
  })

  it('registers the package-owned invariant installer and releases it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(FsNetworkDriveInvariant).await()
    // The registry refuses a second registration under the same package name,
    // which is what makes the mount observable: the same call can only succeed
    // once disposal has released the name.
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-fs-network-drive', () => {})).toThrow('already registered')
    await fiber.dispose()
    const release = ctx.invariants.register('@deepseek-ai/dsh-fs-network-drive', () => {})
    expect(typeof release).toBe('function')
    release()
  })
})
