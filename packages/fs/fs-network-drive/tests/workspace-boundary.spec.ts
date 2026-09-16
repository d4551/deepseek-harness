import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import { drivePath } from '@deepseek-ai/dsh-network-drive/identity'
import { DriveAddressing } from '../src/addressing.ts'
import { DriveTransfer } from '../src/transfer.ts'
import { bootWebDav } from './webdav-server.ts'

it('denies reading through a local directory link that leaves the workspace', async () => {
  const { ctx, workspace } = await bootWebDav()
  const outside = join(workspace, '..', 'private')
  await mkdir(outside)
  await writeFile(join(outside, 'secret'), 'private content')
  await symlink(outside, join(workspace, 'escape'), 'dir')
  const target = await ctx.fs.resolve('escape/secret')
  await expect(ctx.fs.readText(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(readFile(join(outside, 'secret'), 'utf8')).resolves.toBe('private content')
})

it('denies publishing through a local directory link before either store changes', async () => {
  const { ctx, workspace, remote } = await bootWebDav()
  const outside = join(workspace, '..', 'private')
  await mkdir(outside)
  await writeFile(join(outside, 'retained'), 'private content')
  await symlink(outside, join(workspace, 'escape'), 'dir')
  const target = await ctx.fs.resolve('escape/retained')
  await expect(ctx.fs.writeText(target, 'replacement')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(readFile(join(outside, 'retained'), 'utf8')).resolves.toBe('private content')
  await expect(readFile(join(remote, 'escape/retained'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a link itself but denies listing or inspecting children outside the workspace', async () => {
  const { ctx, workspace, remote } = await bootWebDav()
  const outside = join(workspace, '..', 'private')
  await mkdir(outside)
  await writeFile(join(outside, 'secret'), 'private content')
  await symlink(outside, join(workspace, 'escape'), 'dir')
  await mkdir(join(remote, 'escape'))
  await expect(ctx.fs.lstat('escape')).resolves.toMatchObject({ type: 'symlink' })
  await expect(ctx.fs.lstat('escape/secret')).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(ctx.fs.listDir(await ctx.fs.resolve('escape'))).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(readFile(join(outside, 'secret'), 'utf8')).resolves.toBe('private content')
})

it('rechecks ownership when a delayed stream is first consumed', async () => {
  const { ctx, workspace, remote } = await bootWebDav()
  await writeFile(join(remote, 'entry'), 'remote content')
  const target = await ctx.fs.resolve('entry')
  const stream = await ctx.fs.streamText(target)
  const outside = join(workspace, '..', 'private')
  await writeFile(outside, 'private content')
  await rm(join(workspace, 'entry'))
  await symlink(outside, join(workspace, 'entry'), 'file')
  const iterator = stream[Symbol.asyncIterator]()
  await expect(iterator.next()).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
  await expect(iterator.next()).resolves.toMatchObject({ done: true })
  await expect(readFile(outside, 'utf8')).resolves.toBe('private content')
  await expect(readFile(join(remote, 'entry'), 'utf8')).resolves.toBe('remote content')
})

it('keeps links within the workspace usable for local reads and directory listing', async () => {
  const { ctx, workspace } = await bootWebDav()
  await mkdir(join(workspace, 'owned'))
  await writeFile(join(workspace, 'owned/entry'), 'owned content')
  await symlink(join(workspace, 'owned'), join(workspace, 'alias'), 'dir')
  await expect(ctx.fs.readText(await ctx.fs.resolve('alias/entry'))).resolves.toBe('owned content')
  await expect(ctx.fs.lstat('alias')).resolves.toMatchObject({ type: 'symlink' })
  const listed = await ctx.fs.listDir(await ctx.fs.resolve('.'))
  expect(listed.map(entry => entry.name)).toEqual(['alias', 'owned'])
  expect(listed.find(entry => entry.name === 'alias')).toMatchObject({ type: 'other' })
})

it('projects a configured remote subtree and rejects a stale write to an absent entry', async () => {
  const { ctx, workspace, remote } = await bootWebDav()
  await mkdir(join(remote, 'tenant'))
  await writeFile(join(remote, 'tenant/entry'), 'tenant content')
  await writeFile(join(remote, 'outside'), 'other content')
  const config = { materializationRoot: workspace, remoteRoot: drivePath('tenant'), maxFileBytes: 1024 }
  const addressing = new DriveAddressing(config, () => ctx.networkDrive)
  const transfer = new DriveTransfer(config, addressing, () => ctx.networkDrive)
  const root = addressing.targetFor(drivePath(''))
  expect(addressing.drivePathOfTarget(root)).toBe('tenant')
  expect((await addressing.listEntries(root, undefined)).map(entry => entry.name)).toEqual(['entry'])
  const target = addressing.targetOf('entry', workspace, 'read')
  await expect(transfer.readText(target, undefined)).resolves.toBe('tenant content')
  const absent = await ctx.fs.resolve('absent')
  await expect(ctx.fs.writeText(absent, 'rejected', { kind: 'replaceIfVersion', version: FsVersion('drive:unobserved') }))
    .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  await expect(readFile(join(remote, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' })
  const empty = ctx.fs.resolve(' ')
  expect(empty).toBeInstanceOf(Promise)
  await expect(empty).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  await expect(ctx.fs.resolve('entry', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'FS_ABORTED' })
})
