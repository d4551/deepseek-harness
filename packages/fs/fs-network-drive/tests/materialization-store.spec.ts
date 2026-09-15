import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { drivePath, driveVersion } from '@deepseek-ai/dsh-network-drive/identity'
import { expect, it, onTestFinished } from 'vitest'
import {
  digestOf, digestOfFile, localInfo, materialize, materializeDirectory,
  publishBytes, readBounded, readRecord, stateRootOf, verifiedCopy, writeRecord,
} from '../src/materialization.ts'

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'drive-store-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}

it('distinguishes absent entries from traversal and metadata failures', async () => {
  const root = await workspace()
  await writeFile(join(root, 'file'), 'bytes')
  await symlink('cycle', join(root, 'cycle'), 'dir')
  await expect(localInfo(join(root, 'missing'))).resolves.toBeUndefined()
  await expect(localInfo(join(root, 'file', 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  await expect(localInfo(join(root, 'cycle', 'child'))).rejects.toMatchObject({ code: 'ELOOP' })
  await expect(localInfo(join(root, 'cycle'))).resolves.toEqual({ type: 'symlink' })
  await expect(localInfo(root)).resolves.toEqual({ type: 'directory' })
  await expect(localInfo(join(root, 'file'))).resolves.toEqual({ type: 'file', size: 5 })
})

it('reports native special files as non-file entries without reading them', async () => {
  const root = await workspace()
  let special = String.raw`\\.\NUL`
  if (process.platform !== 'win32') {
    const server = createServer()
    onTestFinished(() => server[Symbol.asyncDispose]())
    special = join(root, 'socket')
    server.listen(special)
    await once(server, 'listening')
  }
  await expect(localInfo(special)).resolves.toEqual({ type: 'other' })
})

it('publishes complete bytes, replaces the previous file and drains staging', async () => {
  const root = await workspace()
  const target = join(root, 'entry')
  await writeFile(target, 'previous')
  const bytes = Buffer.alloc(128 * 1024 + 7, 0xa5)
  await publishBytes(root, target, bytes, 0o600)
  await expect(readFile(target)).resolves.toEqual(bytes)
  await expect(digestOfFile(target)).resolves.toBe(digestOf(bytes))
  await expect(readBounded(target, 3)).resolves.toEqual(new Uint8Array(bytes.subarray(0, 4)))
  await expect(readdir(join(stateRootOf(root), 'staging'))).resolves.toEqual([])
})

it('removes staged bytes after native publication failures and preserves the destination', async () => {
  const root = await workspace()
  const target = join(root, 'directory')
  await mkdir(target)
  await writeFile(join(target, 'retained'), 'existing')
  await expect(publishBytes(root, target, Buffer.from('new'), 0o600)).rejects.toMatchObject({ code: process.platform === 'win32' ? 'EPERM' : 'EISDIR' })
  await expect(readFile(join(target, 'retained'), 'utf8')).resolves.toBe('existing')
  await expect(readdir(join(stateRootOf(root), 'staging'))).resolves.toEqual([])
  await expect(publishBytes(root, join(root, 'missing', 'child'), Buffer.from('new'), 0o600))
    .rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(join(stateRootOf(root), 'staging'))).resolves.toEqual([])
  await publishBytes(root, join(root, 'recovered'), Buffer.from('next'), 0o600)
  await expect(readFile(join(root, 'recovered'), 'utf8')).resolves.toBe('next')
})

it('verifies revision, length and digest independently, including an empty file', async () => {
  const root = await workspace()
  const path = drivePath('nested/file')
  const version = driveVersion('revision')
  const bytes = Buffer.from('stored')
  await expect(verifiedCopy(root, path, version)).resolves.toBeUndefined()
  await materialize(root, path, bytes, version)
  await expect(readRecord(root, path)).resolves.toEqual({ version, digest: digestOf(bytes), bytes: bytes.length })
  await expect(verifiedCopy(root, path, version)).resolves.toBe(bytes.length)
  await expect(verifiedCopy(root, path, driveVersion('other'))).resolves.toBeUndefined()
  await writeFile(join(root, path), 'edited')
  await expect(verifiedCopy(root, path, version)).resolves.toBeUndefined()
  await writeFile(join(root, path), 'stored longer')
  await expect(verifiedCopy(root, path, version)).resolves.toBeUndefined()
  await rm(join(root, path))
  await expect(verifiedCopy(root, path, version)).resolves.toBeUndefined()
  await materialize(root, path, Buffer.alloc(0), version)
  await expect(verifiedCopy(root, path, version)).resolves.toBe(0)
  await materializeDirectory(root, drivePath('new/directory'))
  await expect(localInfo(join(root, 'new/directory'))).resolves.toEqual({ type: 'directory' })
})

it('rejects corrupt persisted records before trusting workspace bytes', async () => {
  const root = await workspace()
  const path = drivePath('entry')
  const version = driveVersion('revision')
  const record = { version, digest: digestOf(Buffer.from('x')), bytes: 1 }
  await writeRecord(root, path, record)
  const directories = await readdir(join(stateRootOf(root), 'records'))
  expect(directories).toHaveLength(1)
  const directory = join(stateRootOf(root), 'records', directories[0]!)
  const files = await readdir(directory)
  expect(files).toHaveLength(1)
  const filename = join(directory, files[0]!)
  for (const raw of [
    '{', 'null', '17', '[]', JSON.stringify({ version }), JSON.stringify({ version, digest: record.digest }),
    JSON.stringify({ ...record, version: '' }),
    JSON.stringify({ ...record, version: 1 }),
    JSON.stringify({ ...record, digest: 'z'.repeat(64) }),
    JSON.stringify({ ...record, digest: 1 }),
    JSON.stringify({ ...record, bytes: -1 }),
    JSON.stringify({ ...record, bytes: 0.5 }),
    JSON.stringify({ ...record, bytes: '1' }),
  ]) {
    await writeFile(filename, raw)
    await expect(readRecord(root, path)).resolves.toBeUndefined()
  }
  await writeRecord(root, path, record)
  await expect(readRecord(root, path)).resolves.toEqual(record)
})
