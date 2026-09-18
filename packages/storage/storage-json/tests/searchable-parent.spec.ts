import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '../src/index.ts'

describe.each(['single', 'per-record'] satisfies KvUnitDescriptor['layout'][])('%s beneath a searchable parent', (layout) => {
  it('shares and retains a failed root publication across concurrent and later unit opens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-root-publication-'))
    const root = join(directory, 'data')
    const backend = new JsonStorageBackend(root)
    onTestFinished(async () => {
      await backend.close()
      await chmod(directory, 0o700)
      await rm(directory, { recursive: true, force: true })
    })
    if (process.platform === 'win32') await writeFile(root, 'occupied')
    else await chmod(directory, 0o300)
    const descriptor: KvUnitDescriptor = { name: 'workspaces', version: 1, tables: ['items'], hasGlobal: false, layout }
    const results = await Promise.allSettled([
      backend.kv.open(descriptor),
      backend.kv.open({ ...descriptor, name: 'preferences' }),
    ])
    const [first, second] = results
    assert.ok(first?.status === 'rejected')
    assert.ok(second?.status === 'rejected')
    expect(second.reason).toBe(first.reason)
    await expect(backend.kv.open({ ...descriptor, name: 'later' })).rejects.toBe(first.reason)
    if (process.platform !== 'win32') {
      expect(first.reason).toMatchObject({ code: 'EACCES', syscall: 'open', path: directory })
      expect((await stat(root)).isDirectory()).toBe(true)
      expect((await stat(directory)).mode & 0o777).toBe(0o300)
    }
  })

  it.each(['existing', 'nested'])('persists and reopens a %s root without reading an unchanged ancestor', async (placement) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-searchable-parent-'))
    const parent = join(directory, 'restricted')
    const home = join(parent, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const root = placement === 'existing' ? home : join(home, 'parent', 'data')
    const backend = new JsonStorageBackend(root)
    const reopened = new JsonStorageBackend(root)
    onTestFinished(async () => {
      await backend.close()
      await reopened.close()
      await chmod(parent, 0o700)
      await rm(directory, { recursive: true, force: true })
    })
    if (process.platform !== 'win32') {
      await chmod(parent, 0o100)
      await expect(access(parent, constants.R_OK)).rejects.toMatchObject({ code: 'EACCES' })
    }
    const descriptor: KvUnitDescriptor = { name: 'workspaces', version: 1, tables: ['items'], hasGlobal: true, layout }
    const unit = await backend.kv.open(descriptor)
    await unit.putRecord('items', 'saved', { path: '/project' })
    await unit.setGlobal({ selected: 'saved' })
    await backend.close()

    const durable = await reopened.kv.open(descriptor)
    expect(await durable.loadAll()).toEqual({
      tables: { items: { saved: { path: '/project' } } },
      global: { selected: 'saved' },
    })
    if (process.platform !== 'win32') {
      expect((await stat(parent)).mode & 0o777).toBe(0o100)
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      await expect(access(parent, constants.R_OK)).rejects.toMatchObject({ code: 'EACCES' })
    }
  })
})
