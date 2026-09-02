/**
 * The network-drive Service Definition's own vocabulary: what a drive path may
 * name, what a revision token may be, how the typed error carries its code, and
 * that a provider subclass registers as `ctx.networkDrive`.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { NetworkDrive } from '@deepseek-ai/dsh-network-drive'
import {
  DriveError,
  driveChildPath,
  driveParentPath,
  drivePath,
  driveVersion,
} from '@deepseek-ai/dsh-network-drive/identity'
import type {
  DriveByteRange,
  DriveContent,
  DriveDirEntry,
  DrivePath,
  DriveStat,
  DriveVersion,
  DriveWriteIntent,
} from '@deepseek-ai/dsh-network-drive/types'
import * as NetworkDriveInvariant from '../src/invariant.ts'

/** The smallest subclass that proves the abstract members are the ones a provider implements. */
class StubDrive extends NetworkDrive {
  override async stat(path: DrivePath): Promise<DriveStat | undefined> {
    return { path, type: 'file', version: driveVersion('rev-1'), size: 0 }
  }

  override async list(): Promise<DriveDirEntry[]> {
    return []
  }

  override async read(path: DrivePath, range: DriveByteRange | undefined): Promise<DriveContent> {
    return { bytes: new Uint8Array(range?.length ?? 0), version: driveVersion(`rev-${path}`) }
  }

  override async write(_path: DrivePath, _bytes: Uint8Array, _expected: DriveWriteIntent | undefined): Promise<DriveVersion> {
    return driveVersion('rev-2')
  }

  override async remove(): Promise<void> {}

  override async move(): Promise<void> {}

  override async makeDirectory(): Promise<void> {}
}

describe('drive path identity', () => {
  it('normalizes an addressable relative path and names the root with the empty string', () => {
    expect(drivePath('')).toBe('')
    expect(drivePath('a/b/c.txt')).toBe('a/b/c.txt')
    expect(driveChildPath(drivePath(''), 'top.txt')).toBe('top.txt')
    expect(driveChildPath(drivePath('dir'), 'leaf.txt')).toBe('dir/leaf.txt')
    expect(driveParentPath(drivePath('dir/leaf.txt'))).toBe('dir')
    expect(driveParentPath(drivePath('leaf.txt'))).toBe('')
    expect(driveParentPath(drivePath(''))).toBe('')
  })

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a parent traversal', 'a/../../etc'],
    ['a bare traversal segment', '..'],
    ['a current-directory segment', 'a/./b'],
    ['an empty segment', 'a//b'],
    ['a Windows separator', String.raw`a\b`],
    ['an embedded NUL', 'a\0b'],
  ])('rejects %s', (_label, value) => {
    expect(() => drivePath(value)).toThrow(TypeError)
  })

  it('rejects a multi-segment child name and an empty revision token', () => {
    expect(() => driveChildPath(drivePath('dir'), 'a/b')).toThrow('must be one segment')
    expect(() => driveVersion('')).toThrow('non-empty')
    expect(driveVersion('etag:"abc"')).toBe('etag:"abc"')
  })
})

describe('drive errors', () => {
  it('carries a routable code, its class name, and the chained cause', () => {
    const cause = new Error('socket closed')
    const error = new DriveError('cannot read "a.txt": transport failed', 'DRIVE_IO_ERROR', { cause })
    expect(error.code).toBe('DRIVE_IO_ERROR')
    expect(error.name).toBe('DriveError')
    expect(error.cause).toBe(cause)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('the Service Definition', () => {
  it('registers a provider subclass as ctx.networkDrive and disposes with its fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubDrive)
    const drive = ctx.networkDrive
    expect(drive).toBeInstanceOf(NetworkDrive)
    await expect(drive.stat(drivePath('a.txt'))).resolves.toMatchObject({ type: 'file' })
    await expect(drive.read(drivePath('a.txt'), { offset: 0, length: 4 })).resolves.toMatchObject({
      bytes: new Uint8Array(4),
    })
    await fiber.dispose()
    expect(ctx.get('networkDrive')).toBeUndefined()
  })

  it('registers the package-owned invariant installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(NetworkDriveInvariant).await()
    await fiber.dispose()
  })
})
