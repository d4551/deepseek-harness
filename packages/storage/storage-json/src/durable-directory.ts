/** Directory entry persistence for JSON unit and table publication. */

import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ensureDurableDirectoryWin32 } from '@deepseek-ai/dsh-atomic-write/win32'

/**
 * Create private directories and persist each newly created entry in its parent.
 * @param path - Directory to create, resolved against the current working directory.
 * @returns completion after created-entry publication; filesystem errors reject.
 */
export async function ensureDurableDirectory(path: string): Promise<void> {
  const target = resolve(path)
  if (process.platform === 'win32') {
    await ensureDurableDirectoryWin32(target)
    return
  }
  const firstCreated = await mkdir(target, { recursive: true, mode: 0o700 })
  if (firstCreated === undefined) return
  const boundary = dirname(firstCreated)
  let current = target
  while (current !== boundary) {
    current = dirname(current)
    const handle = await open(current, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}
