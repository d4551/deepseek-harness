/**
 * The file-as-parent probe, exercised on a POSIX host.
 *
 * `canonicalizeWatchPath` walks up to the nearest existing ancestor and then
 * opens it, because a path whose parent is a regular file must not resolve.
 * POSIX never reaches that probe: `realpath` reports ENOTDIR for a path that
 * traverses a file, and the walk rethrows anything that is not ENOENT.
 * Windows reports ENOENT there instead, so the probe is the only thing that
 * catches a file-as-parent on that platform — and nothing covered it, because
 * the suite runs on POSIX.
 *
 * Answering `realpath` with ENOENT reaches that branch here. What this pins is
 * the harness's own decision — walk up, then open the ancestor and let the
 * failure through — not Windows itself: the error the assertion reads comes
 * from this host's `opendir`, and only a Windows run proves the errno Windows
 * reports for the same call.
 */

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      if (String(path).endsWith('child')) {
        const error: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory')
        error.code = 'ENOENT'
        throw error
      }
      return actual.realpath(path)
    },
  }
})

const { canonicalizeWatchPath } = await import('@deepseek-ai/dsh-home-paths')

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('canonicalizeWatchPath on a Windows-style ENOENT', () => {
  it('refuses a path whose parent is a regular file', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-file-parent-'))
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'content')

    // The ancestor resolves, so only opening it reveals that it is a file.
    // Without that probe this returns a path that can never be watched.
    await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('still resolves a missing path under a real directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-file-parent-ok-'))
    // The ancestor is realpath'd; macOS tmpdir is /var → /private/var.
    await expect(canonicalizeWatchPath(join(root, 'child'))).resolves.toBe(join(await realpath(root), 'child'))
  })
})
