import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { bootWebDav } from './webdav-server.ts'

const execute = promisify(execFile)

it('reports a native working-directory listing denial after metadata remains readable', async () => {
  const { ctx, workspace } = await bootWebDav()
  const directory = join(workspace, 'protected')
  await mkdir(directory)
  await writeFile(join(directory, 'entry'), 'retained')
  await denyAccess(directory, 'RD', 0o000)
  await expect(readdir(directory)).rejects.toMatchObject({ code: 'EACCES' })
  const target = await ctx.fs.resolve('protected')
  await expect(ctx.fs.stat(target)).resolves.toMatchObject({ type: 'directory' })
  await expect(ctx.fs.listDir(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED' })
})

async function denyAccess(path: string, rights: string, permissions: number): Promise<void> {
  const mode = (await stat(path)).mode & 0o777
  if (process.platform === 'win32') {
    const username = userInfo().username
    await execute('icacls', [path, '/deny', `${username}:(${rights})`])
    onTestFinished(async () => { await execute('icacls', [path, '/remove:d', username]) })
  } else {
    await chmod(path, permissions)
    onTestFinished(() => chmod(path, mode))
  }
}

it('retains native permission denial while deriving a local file version', async () => {
  const { ctx, workspace } = await bootWebDav()
  const path = join(workspace, 'private')
  await writeFile(path, 'retained')
  await denyAccess(path, 'RD', 0o000)
  await expect(readFile(path)).rejects.toMatchObject({ code: 'EACCES' })
  const target = await ctx.fs.resolve('private')
  await expect(ctx.fs.stat(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED', cause: { code: 'EACCES' } })
  await expect(ctx.fs.readText(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED', cause: { code: 'EACCES' } })
})

it('reports local publication denial after reading real remote content', async () => {
  const { ctx, workspace, remote } = await bootWebDav()
  await writeFile(join(remote, 'entry'), 'remote content')
  await denyAccess(workspace, 'WD,AD', 0o500)
  const target = await ctx.fs.resolve('entry')
  await expect(ctx.fs.readText(target)).rejects.toMatchObject({ code: 'FS_PERMISSION_DENIED', cause: { code: 'EACCES' } })
  await expect(readFile(join(remote, 'entry'), 'utf8')).resolves.toBe('remote content')
  await expect(readFile(join(workspace, 'entry'))).rejects.toMatchObject({ code: 'ENOENT' })
})
