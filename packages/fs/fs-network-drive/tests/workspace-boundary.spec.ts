import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
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
