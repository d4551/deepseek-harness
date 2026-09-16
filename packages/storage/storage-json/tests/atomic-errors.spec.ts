import { rejects } from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { writeAtomic } from '../src/atomic.ts'

it('retains the opening failure when no staging file was created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-atomic-open-'))
  try {
    const neighbor = join(root, 'neighbor.json')
    await writeFile(neighbor, 'unchanged')
    await rejects(writeAtomic(join(root, 'missing', 'unit.json'), '{"record":1}'), error => (
      error instanceof Error
      && 'code' in error && error.code === 'ENOENT'
      && 'syscall' in error && error.syscall === 'open'
      && 'path' in error && typeof error.path === 'string'
      && error.path.startsWith(join(root, 'missing'))
    ))
    expect(await readdir(root)).toEqual(['neighbor.json'])
    expect(await readFile(neighbor, 'utf8')).toBe('unchanged')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('removes its staging file after native replacement rejects an occupied directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-atomic-commit-'))
  try {
    const target = join(root, 'occupied')
    await mkdir(target)
    await writeFile(join(target, 'child.json'), 'unchanged')
    await rejects(writeAtomic(target, 'replacement'), error => (
      error instanceof Error
      && 'dest' in error && error.dest === target
      && 'syscall' in error && error.syscall === (process.platform === 'win32' ? 'MoveFileExW' : 'rename')
    ))
    expect(await readdir(root)).toEqual(['occupied'])
    expect(await readdir(target)).toEqual(['child.json'])
    expect(await readFile(join(target, 'child.json'), 'utf8')).toBe('unchanged')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
