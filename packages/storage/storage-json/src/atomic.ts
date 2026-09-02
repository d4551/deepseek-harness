/**
 * Atomic whole-file replacement for the JSON backend.
 *
 * Publish protocol: write a same-directory temp file, fsync it, then replace
 * the target with it atomically and durably. Replacement is the intended
 * semantic here — unlike the session-log backend's link()+unlink() no-clobber
 * protocol, a unit file has exactly one writer per process and
 * last-write-wins is correct. POSIX `rename()` publishes the entry and an
 * fsync of the parent directory makes it crash-durable; Windows has no
 * parent-directory fsync, so the replacement itself carries the flush
 * (`MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`).
 * @module @deepseek-ai/dsh-storage-json/src/atomic
 */

import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { replaceFileDurablyWin32 } from '@deepseek-ai/dsh-atomic-write/win32'

/**
 * Durably replace `path` with `data`.
 * @param path - Absolute target file path.
 * @param data - Full new file content.
 * @returns resolution after the replacement is crash-durable.
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await commitDurably(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * Publish the staged file over `path` so the new directory entry survives a
 * crash. Windows exposes no directory fsync through Node, so the write-through
 * replacement is its peer of the POSIX rename-then-fsync pair.
 * @param temp - the synced staging file.
 * @param path - the target being replaced.
 */
async function commitDurably(temp: string, path: string): Promise<void> {
  /* v8 ignore next -- native Windows coverage takes this arm; POSIX coverage takes the peer below. */
  if (process.platform === 'win32') return replaceFileDurablyWin32(temp, path)
  await rename(temp, path)
  await fsyncDirectory(dirname(path))
}

/** fsync a POSIX directory so a just-renamed entry is crash-durable. */
async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
