/**
 * Successful write-through publication: the drive commits before the workspace
 * copy changes and before success is reported, missing files and their drive
 * parents are created, and a working file the local execution world created
 * publishes upward.
 */

import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setup } from './harness.ts'

describe('NetworkDriveFileSystem write-through publication', () => {
  it('commits to the drive before the workspace copy changes and before success is reported', async () => {
    const { fs, drive } = await setup((d) => { d.file('notes.md', 'before') })
    const target = await fs.resolve('notes.md')
    await fs.readText(target)

    let workspaceDuringDriveWrite: string | undefined
    drive.onWrite = () => {
      workspaceDuringDriveWrite = readFileSync(fs.processPath(target), 'utf8')
    }
    const outcome = await fs.writeText(target, 'after')

    expect(workspaceDuringDriveWrite).toBe('before')
    expect(drive.contentOf('notes.md')).toBe('after')
    await expect(readFile(fs.processPath(target), 'utf8')).resolves.toBe('after')
    expect(outcome).toMatchObject({ operation: 'update', before: 'before', after: 'after' })
    expect(String(outcome.version).startsWith('drive:')).toBe(true)
  })

  it('creates a missing file and its drive parents, then edits it in place', async () => {
    const { fs, drive } = await setup()
    const target = await fs.resolve('drafts/new.md')

    const created = await fs.writeText(target, 'one\ntwo\n')
    expect(created).toMatchObject({ operation: 'create', before: null })
    expect(drive.directories).toContain('drafts')
    expect(drive.contentOf('drafts/new.md')).toBe('one\ntwo\n')

    const edited = await fs.editText(target, { oldString: 'two', newString: 'three', replaceAll: false })
    expect(edited).toMatchObject({ before: 'one\ntwo\n', after: 'one\nthree\n' })
    expect(drive.contentOf('drafts/new.md')).toBe('one\nthree\n')
    await expect(readFile(fs.processPath(target), 'utf8')).resolves.toBe('one\nthree\n')
  })

  it('publishes a working file the local execution world created', async () => {
    const { fs, drive, root } = await setup()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'shell.txt'), 'written by bash')
    const target = await fs.resolve('src/shell.txt')

    await expect(fs.readText(target)).resolves.toBe('written by bash')
    expect(drive.reads).toHaveLength(0)
    const outcome = await fs.writeText(target, 'published')
    expect(outcome).toMatchObject({ operation: 'update', before: 'written by bash' })
    expect(drive.contentOf('src/shell.txt')).toBe('published')
  })
})
