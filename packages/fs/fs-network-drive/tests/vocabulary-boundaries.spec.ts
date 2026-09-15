import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import { DriveError, driveVersion } from '@deepseek-ai/dsh-network-drive/identity'
import { expect, it } from 'vitest'
import {
  assertNotAborted, driveToken, fsType, fsTypeOfLocal, isProviderVersion,
  landing, localToken, mapError, targetKeyFor, workspacePathOfKey,
} from '../src/vocabulary.ts'

it('decodes only provider-owned target keys, including the workspace root', () => {
  for (const path of ['', 'nested/file', '..hidden']) {
    expect(workspacePathOfKey(targetKeyFor(path))).toBe(path)
  }
  for (const key of ['', 'local:file', 'other:file', 'file', 'DRIVE:file']) {
    expect(() => workspacePathOfKey(key)).toThrow(expect.objectContaining({ code: 'FS_PERMISSION_DENIED' }))
  }
})

it('requires an actual revision or local identity after the authority prefix', () => {
  expect(isProviderVersion(driveToken(driveVersion('revision')))).toBe(true)
  expect(isProviderVersion(localToken('directory'))).toBe(true)
  for (const value of ['', 'drive:', 'local:', 'other:revision']) {
    expect(isProviderVersion(FsVersion(value))).toBe(false)
  }
  expect(driveToken(driveVersion('directory'))).not.toBe(localToken('directory'))
})

it('retains typed failures and their causes while applying cancellation priority', async () => {
  const existing = new FsError('denied', 'FS_PERMISSION_DENIED')
  const signal = AbortSignal.abort()
  expect(mapError(existing, 'read', 'entry', signal)).toBe(existing)
  const denied = new DriveError('credential rejected', 'DRIVE_UNAUTHENTICATED')
  expect(mapError(denied, 'read', 'entry')).toMatchObject({ code: 'FS_PERMISSION_DENIED', cause: denied })
  expect(mapError(denied, 'read', 'entry', signal)).toMatchObject({ code: 'FS_ABORTED', cause: denied })
  const unavailable = new Error('disk unavailable')
  expect(mapError(unavailable, 'write', 'entry')).toMatchObject({ code: 'FS_IO_ERROR', cause: unavailable })
  const missing = Object.assign(new Error('gone'), { code: 'ENOENT' })
  expect(mapError(missing, 'read', 'entry')).toMatchObject({ code: 'FS_NOT_FOUND', cause: missing })
  await expect(landing(Promise.reject(denied))).resolves.toEqual({ ok: false, reason: denied })
  const interrupted = Promise.resolve().then(() => { AbortSignal.abort('disconnected').throwIfAborted() })
  await expect(landing(interrupted)).resolves.toEqual({ ok: false, reason: new Error('disconnected') })
  await expect(landing(Promise.resolve(7))).resolves.toEqual({ ok: true, value: 7 })
  expect(() => { assertNotAborted(signal, 'write') }).toThrow(expect.objectContaining({ code: 'FS_ABORTED' }))
  expect(() => { assertNotAborted(undefined, 'write') }).not.toThrow()
  expect(() => { assertNotAborted(new AbortController().signal, 'write') }).not.toThrow()
})

it('preserves remote entry kinds and keeps local symbolic links out of regular-file metadata', () => {
  expect(fsType('file')).toBe('file')
  expect(fsType('directory')).toBe('directory')
  expect(fsType('other')).toBe('other')
  expect(fsTypeOfLocal('file')).toBe('file')
  expect(fsTypeOfLocal('directory')).toBe('directory')
  expect(fsTypeOfLocal('symlink')).toBe('other')
  expect(fsTypeOfLocal('other')).toBe('other')
})

it('rejects unsupported entry and error variants supplied by JavaScript providers', () => {
  expect(() => { Reflect.apply(fsType, undefined, ['symlink']) }).toThrow('unreachable variant in drive entry type')
  expect(() => { Reflect.apply(mapError, undefined, [
    Reflect.construct(DriveError, ['unsupported provider response', 'DRIVE_UNRECOGNIZED']), 'read', 'entry',
  ]) }).toThrow('unreachable variant in drive error')
})
