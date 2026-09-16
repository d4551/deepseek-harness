import { spawnSync } from 'node:child_process'
import { chown, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import { probe, readWholeBytes, readWholeText, resolveLocalTarget } from '../src/fsio.ts'
import { verifyNativeReadDenials } from './fixtures/fsio-permissions.ts'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-fsio-native-errors-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('native filesystem errors', () => {
  it('preserves denied-read errors and recovers after native permissions are restored', async () => {
    if (process.geteuid?.() === 0) {
      await chown(directory, 65534, 65534)
      const child = spawnSync(process.execPath, [
        '--import', 'tsx', join(import.meta.dirname, 'fixtures/fsio-permissions.ts'), directory,
      ], { encoding: 'utf8' })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0)
      expect(child.stdout).toBe('')
      expect(child.stderr).toBe('')
    } else {
      await verifyNativeReadDenials(directory)
    }
  })

  it('preserves symlink-loop errors through resolution, probing, and read preflight', async () => {
    const loop = join(directory, 'loop')
    await symlink(loop, loop, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveLocalTarget(directory, 'loop')).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(probe(loop)).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(readWholeText({ displayPath: loop, targetKey: FsTargetKey(loop) }))
      .rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('translates cancellation after a raw-byte read starts into FS_ABORTED', async () => {
    const file = join(directory, 'bytes.bin')
    await writeFile(file, Buffer.from([1, 2, 3, 4]))
    const controller = new AbortController()
    const pending = readWholeBytes({ displayPath: file, targetKey: FsTargetKey(file) }, controller.signal, 4)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(await readFile(file)).toEqual(Buffer.from([1, 2, 3, 4]))
  })
})
