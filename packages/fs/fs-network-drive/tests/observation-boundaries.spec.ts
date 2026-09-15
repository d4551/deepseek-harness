import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { expect, it, onTestFinished } from 'vitest'
import NetworkDriveFileSystem from '../src/index.ts'
import * as observationInvariant from '../src/invariant.ts'

it('checks the mounted provider authority before accepting observations and releases checks on disposal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drive-observation-')))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(InvariantRegistry, { enabled: true })
  const checks = await ctx.plugin(observationInvariant).await()
  const foreign = { targetKey: FsTargetKey('local:entry'), displayPath: join(root, 'entry') }
  expect(() => { ctx.emit('fs/observed', foreign, { kind: 'absent' }, undefined) }).not.toThrow()
  const fs = new NetworkDriveFileSystem(ctx, { materializationRoot: root, remoteRoot: '', maxFileBytes: 1024 })
  const target = await fs.resolve('entry')
  expect(() => { ctx.emit('fs/observed', target, { kind: 'absent' }, undefined) }).not.toThrow()
  for (const version of ['drive:revision', 'local:directory']) {
    expect(() => { ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion(version) }, undefined) }).not.toThrow()
  }
  expect(() => { ctx.emit('fs/observed', foreign, { kind: 'absent' }, undefined) }).toThrow('did not mint')
  for (const displayPath of [join(root, '..', 'outside'), join(root, '.dsh-network-drive', 'records')]) {
    expect(() => { ctx.emit('fs/observed', { ...target, displayPath }, { kind: 'absent' }, undefined) }).toThrow('outside the materialization root')
  }
  for (const version of ['foreign:revision', 'drive:', 'local:']) {
    expect(() => { ctx.emit('fs/observed', target, { kind: 'present', version: FsVersion(version) }, undefined) }).toThrow('did not issue')
  }
  expect(() => fs.processPath(foreign)).toThrow(expect.objectContaining({ code: 'FS_PERMISSION_DENIED' }))
  expect(fs.processPath(target)).toBe(join(root, 'entry'))
  await checks.dispose()
  expect(() => { ctx.emit('fs/observed', foreign, { kind: 'absent' }, undefined) }).not.toThrow()
})

it('reports native path failures through lstat without consulting an unavailable drive', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'drive-local-probe-')))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const fs = new NetworkDriveFileSystem(ctx, { materializationRoot: root, remoteRoot: '', maxFileBytes: 1024 })
  await writeFile(join(root, 'file'), 'bytes')
  await symlink('cycle', join(root, 'cycle'), 'dir')
  for (const [path, code] of [['file/child', 'ENOTDIR'], ['cycle/child', 'ELOOP']]) {
    await expect(fs.lstat(path!)).rejects.toMatchObject({ code: 'FS_IO_ERROR', cause: { code } })
  }
  await expect(fs.lstat('cycle')).resolves.toMatchObject({ type: 'symlink', version: FsVersion('local:symlink') })
})
