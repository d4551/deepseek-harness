import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs'
import {
  listDirectory, readForEdit, readTextForDiff, readWholeBytes, readWholeText, streamWholeText,
} from '../../src/fsio.ts'

function changeDacl(path: string, operation: '/deny' | '/remove:d'): void {
  const rights = operation === '/deny' ? '*S-1-1-0:(RD)' : '*S-1-1-0'
  const result = spawnSync('icacls', [path, operation, rights], { encoding: 'utf8' })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

/** Exercise actual denied reads and restore the test-owned permission before cleanup. */
export async function verifyNativeReadDenials(root: string): Promise<void> {
  const file = join(root, 'read-denied.txt')
  const original = 'retained content\n'
  await writeFile(file, original, { mode: 0o600 })
  const target = { displayPath: file, targetKey: FsTargetKey(file) }
  if (process.platform === 'win32') changeDacl(file, '/deny')
  else await chmod(file, 0o000)
  try {
    await assert.rejects(readWholeText(target), { code: 'EACCES' })
    await assert.rejects(readForEdit(file, file), { code: 'EACCES' })
    await assert.rejects(readWholeBytes(target, undefined, 1024), { code: 'EACCES' })
    await assert.rejects(async () => {
      const chunks: string[] = []
      for await (const chunk of streamWholeText(target)) chunks.push(chunk)
      return chunks
    }, { code: 'EACCES' })
    assert.equal(await readTextForDiff(file, 1024), null)
  } finally {
    if (process.platform === 'win32') changeDacl(file, '/remove:d')
    else await chmod(file, 0o600)
  }
  assert.equal(await readFile(file, 'utf8'), original)
  assert.equal(await readWholeText(target), original)

  const directory = join(root, 'list-denied')
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(directory, 'retained.txt'), original)
  if (process.platform === 'win32') changeDacl(directory, '/deny')
  else await chmod(directory, 0o000)
  try {
    await assert.rejects(listDirectory({ displayPath: directory, targetKey: FsTargetKey(directory) }), (error) => {
      assert.ok(error instanceof FsError)
      assert.equal(error.code, 'FS_PERMISSION_DENIED')
      assert.ok(error.cause instanceof Error && 'code' in error.cause)
      assert.equal(error.cause.code, 'EACCES')
      return true
    })
  } finally {
    if (process.platform === 'win32') changeDacl(directory, '/remove:d')
    else await chmod(directory, 0o700)
  }
  assert.equal(await readFile(join(directory, 'retained.txt'), 'utf8'), original)
  const entries = await listDirectory({ displayPath: directory, targetKey: FsTargetKey(directory) })
  assert.deepEqual(entries.map(entry => [entry.name, entry.type, entry.size]), [
    ['retained.txt', 'file', Buffer.byteLength(original)],
  ])
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  const root = process.argv[2]
  assert.ok(root)
  assert.equal(process.geteuid?.(), 0)
  assert.ok(process.setgid)
  assert.ok(process.setuid)
  process.setgid(65534)
  process.setuid(65534)
  assert.equal(process.geteuid?.(), 65534)
  await verifyNativeReadDenials(root)
}
