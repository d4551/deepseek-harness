/**
 * Workspace identity: process paths, file URLs, containment, host-path
 * mapping, drive metadata alongside local working files and links, and the
 * merged directory listing.
 */

import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectCode, setup } from './harness.ts'

describe('NetworkDriveFileSystem identity and metadata', () => {
  it('projects process paths, file URLs, containment, and host-path mapping', async () => {
    const { fs, root } = await setup((d) => { d.file('nested/file.ts', 'text') })
    const workspace = await fs.resolve('.')
    const nested = await fs.resolve('nested/file.ts')

    expect(fs.processPath(nested)).toBe(join(root, 'nested', 'file.ts'))
    expect(fs.fileUrl(nested)).toBe(new URL(`file://${join(root, 'nested', 'file.ts')}`).href)
    expect(fs.contains(workspace, nested)).toBe(true)
    expect(fs.contains(nested, workspace)).toBe(false)
    // Attachments live outside the drive-backed workspace, so this filesystem
    // must not name them: its own tools would reject the path it handed back.
    expect(fs.processPathFromHostPath(join(root, 'nested', 'file.ts'))).toBe(join(root, 'nested', 'file.ts'))
    expect(fs.processPathFromHostPath('/var/dsh/attachments/object')).toBeUndefined()
    expect(fs.processPathFromHostPath(join(root, '.dsh-network-drive', 'records'))).toBeUndefined()
    expect(fs.processPathFromHostPath('relative.png')).toBeUndefined()
  })

  it('refuses to resolve a path outside the drive-backed workspace', async () => {
    const { fs } = await setup()
    await expectCode(fs.resolve('/etc/hosts'), 'FS_PERMISSION_DENIED')
    await expectCode(fs.resolve('../escape'), 'FS_PERMISSION_DENIED')
    await expectCode(fs.resolve('   '), 'FS_NOT_FOUND')
  })

  it('accepts a filename that begins with dots, which only a prefix test would reject', async () => {
    // `..` escapes the root as a whole segment; `..foo` and `...bar` are
    // ordinary names the drive path vocabulary accepts.
    const { fs, root } = await setup()
    for (const name of ['..foo', '...bar', '..hidden/file.txt']) {
      const target = await fs.resolve(name)
      expect(fs.processPath(target)).toBe(join(root, name))
      expect(fs.processPathFromHostPath(join(root, name))).toBe(join(root, name))
    }
  })

  it('reports drive metadata, local working files, and links through lstat', async () => {
    const { fs, root } = await setup((d) => {
      d.file('on-drive.md', 'remote')
      d.directory('dir')
    })
    await writeFile(join(root, 'working.txt'), 'local only')
    await symlink(join(root, 'working.txt'), join(root, 'link.txt'))

    await expect(fs.stat(await fs.resolve('on-drive.md'))).resolves.toMatchObject({ type: 'file', size: 6 })
    await expect(fs.stat(await fs.resolve('dir'))).resolves.toMatchObject({ type: 'directory' })
    await expect(fs.stat(await fs.resolve('missing.md'))).resolves.toBeUndefined()
    await expect(fs.stat(await fs.resolve('working.txt'))).resolves.toMatchObject({ type: 'file', size: 10 })
    await expect(fs.lstat('link.txt')).resolves.toMatchObject({ type: 'symlink' })
    await expect(fs.lstat('on-drive.md')).resolves.toMatchObject({ type: 'file', size: 6 })
    await expect(fs.lstat('working.txt')).resolves.toMatchObject({ type: 'file' })
    await expect(fs.lstat('missing.md')).resolves.toBeUndefined()
    await expectCode(fs.lstat(' '), 'FS_NOT_FOUND')
  })

  it('lists drive children beside working files the local execution world created', async () => {
    const { fs, root } = await setup((d) => {
      d.file('b.txt', 'b')
      d.directory('sub')
    })
    await writeFile(join(root, 'a-working.txt'), 'shell wrote this')

    const listed = await fs.listDir(await fs.resolve('.'))
    expect(listed.map(entry => entry.name)).toEqual(['a-working.txt', 'b.txt', 'sub'])
    expect(listed.find(entry => entry.name === 'sub')).toMatchObject({ type: 'directory' })
    // The provider's private state never reaches the model.
    expect(listed.some(entry => entry.name === '.dsh-network-drive')).toBe(false)

    await expectCode(fs.listDir(await fs.resolve('b.txt')), 'FS_NOT_DIRECTORY')
    await expectCode(fs.listDir(await fs.resolve('nowhere')), 'FS_NOT_FOUND')
  })
})
