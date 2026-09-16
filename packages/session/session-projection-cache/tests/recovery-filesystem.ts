import { spawnSync } from 'node:child_process'
import { chmod, chown, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

/** Give the non-privileged child ownership of this test's complete data tree. */
export async function preparePermissionChild(root: string): Promise<void> {
  if (process.geteuid?.() !== 0) return
  await chown(root, 65534, 65534)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await preparePermissionChild(path)
    else await chown(path, 65534, 65534)
  }
}

function icacls(path: string, operation: string, rights: string): void {
  const result = spawnSync('icacls', [path, operation, rights], { encoding: 'utf8' })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

/** Deny the actual filesystem operation, using the native permission model. */
export async function denyRecordOperation(path: string, operation: 'read' | 'delete'): Promise<void> {
  if (process.platform === 'win32') {
    icacls(path, '/deny', operation === 'read' ? '*S-1-1-0:(RD)' : '*S-1-1-0:(OI)(CI)(DE,DC)')
  } else {
    await chmod(path, operation === 'read' ? 0o000 : 0o500)
  }
}

/** Restore only the test-owned denial before cleanup or a durable retry. */
export async function restoreRecordOperation(path: string, operation: 'read' | 'delete'): Promise<void> {
  if (process.platform === 'win32') icacls(path, '/remove:d', '*S-1-1-0')
  else await chmod(path, operation === 'read' ? 0o600 : 0o700)
}

/** Execute the source graph through the repository's tsx aliases, with inherited instrumentation. */
export function runPermissionChild(root: string, operation: 'read' | 'delete', id: string): void {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', fileURLToPath(new URL('./recovery-permissions.mjs', import.meta.url)), operation, root, id,
  ], { encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  expect(result.stderr).toBe('')
}
