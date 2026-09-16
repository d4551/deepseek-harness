import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import { landing } from './vocabulary.ts'

function contained(root: string, path: string): boolean {
  const within = relative(root, path)
  return !isAbsolute(within) && !within.split(sep).includes('..')
}

/**
 * Verify a local path's existing ancestry belongs to the materialization root.
 * Missing suffixes are checked against their nearest existing ancestor; other
 * native resolution errors propagate. Callers repeat this before local I/O.
 * @param root - canonical materialization root established at construction.
 * @param path - absolute local path about to be inspected or changed.
 * @param followFinal - false for inspecting or replacing the final entry itself.
 * @throws FsError when lexical or resolved ancestry leaves the workspace.
 */
export async function assertMaterializationPath(root: string, path: string, followFinal = true): Promise<void> {
  const target = resolve(path)
  if (!contained(root, target)) throw new FsError('local path leaves the network-drive workspace', 'FS_PERMISSION_DENIED')
  let ancestor = followFinal || target === root ? target : dirname(target)
  for (;;) {
    const resolved = await landing(realpath(ancestor))
    if (resolved.ok) {
      if (!contained(root, resolved.value)) throw new FsError('local path resolves outside the network-drive workspace', 'FS_PERMISSION_DENIED')
      return
    }
    if (!('code' in resolved.reason) || resolved.reason.code !== 'ENOENT') throw resolved.reason
    if (ancestor === root) throw resolved.reason
    ancestor = dirname(ancestor)
  }
}
