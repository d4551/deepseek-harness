/** Directory entry persistence for JSON unit and table publication. */

import { mkdir, open } from 'node:fs/promises'
import { dirname, parse, resolve } from 'node:path'
import { ensureDurableDirectoryWin32 } from '@deepseek-ai/dsh-atomic-write/win32'

/**
 * Create a private directory and persist every ancestor entry through the filesystem root.
 * @param path - Directory to create, resolved against the current working directory.
 * @returns completion after ancestor publication; filesystem errors reject.
 */
export async function ensureDurableDirectory(path: string): Promise<void> {
  const target = resolve(path)
  if (process.platform === 'win32') {
    await ensureDurableDirectoryWin32(target)
    return
  }
  await mkdir(target, { recursive: true, mode: 0o700 })
  const root = parse(target).root
  let current = target
  while (current !== root) {
    current = dirname(current)
    const handle = await open(current, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}
